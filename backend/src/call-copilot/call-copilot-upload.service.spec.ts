import { BadRequestException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { Observable, of, throwError } from 'rxjs';
import { CallCopilotUploadService } from './call-copilot-upload.service';

// The recorded-call pipeline with everything outside it mocked (no database,
// no python-agent, no Sarvam): the order things happen in, and what a failure
// leaves behind — a saved recording, a readable reason, and a way to retry.

type Session = Record<string, unknown> & { _id: { toString(): string }; save: jest.Mock };

const POLL_MS = 8_000;

function makeSession(fields: Record<string, unknown> = {}): Session {
  return {
    _id: { toString: () => 'session-1' },
    organizationId: 'org-1',
    userId: 'user-1',
    status: 'processing',
    source: 'upload',
    originalRecordingFileId: 'file-1',
    originalFilename: 'plivo-rec.mp3',
    languageCode: 'en',
    creditRequestId: 'credit-1',
    transcript: [],
    events: [],
    save: jest.fn(async () => undefined),
    ...fields,
  };
}

function refused(code: string): Observable<never> {
  return throwError(() => new AxiosError('connect failed', code, { url: 'http://localhost:8000/x', headers: new AxiosHeaders() }));
}

describe('CallCopilotUploadService — recorded calls', () => {
  let service: CallCopilotUploadService;
  let order: string[];
  let sessionModel: { create: jest.Mock; findOne: jest.Mock; findOneAndUpdate: jest.Mock };
  let http: { post: jest.Mock; get: jest.Mock };
  let gridFs: { upload: jest.Mock; download: jest.Mock };
  let reservations: { reserve: jest.Mock; touch: jest.Mock; resolveTenantKey: jest.Mock };
  let copilot: {
    errorSession: jest.Mock;
    appendTranscriptSegment: jest.Mock;
    runBatchAnalysisWindow: jest.Mock;
    endSession: jest.Mock;
    generateCoaching: jest.Mock;
  };
  let gateway: { emitToUser: jest.Mock };
  let pollReplies: Array<() => Observable<unknown>>;

  beforeEach(() => {
    jest.useFakeTimers();
    order = [];
    pollReplies = [];
    sessionModel = {
      create: jest.fn(async (doc: Record<string, unknown>) => {
        order.push('session.create');
        return makeSession(doc);
      }),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    http = {
      post: jest.fn((url: string) => {
        if (url.endsWith('/call-copilot/upload/transcribe-job')) {
          order.push('sarvam.job');
          return of({ data: { jobId: 'job-1' } });
        }
        return of({ data: {} });
      }),
      get: jest.fn(() =>
        (pollReplies.shift() ?? (() => of({ data: { status: 'completed', segments: [{ sequence: 0, text: 'Hello there', speaker: '0' }] } })))(),
      ),
    };
    gridFs = {
      upload: jest.fn(async () => {
        order.push('gridfs.upload');
        return 'file-1';
      }),
      download: jest.fn(async () => Buffer.from([1, 2, 3])),
    };
    reservations = { reserve: jest.fn(async () => undefined), touch: jest.fn(async () => undefined), resolveTenantKey: jest.fn((org: string) => org) };
    copilot = {
      errorSession: jest.fn(async (s: Session, message: string, options: { retryable?: boolean } = {}) => {
        Object.assign(s, { status: 'error', errorMessage: message, retryable: options.retryable });
      }),
      appendTranscriptSegment: jest.fn(async () => undefined),
      runBatchAnalysisWindow: jest.fn(async () => ({ skipped: true })),
      endSession: jest.fn(async (s: Session) => Object.assign(s, { status: 'ended' })),
      generateCoaching: jest.fn(async (s: Session) => s),
    };
    gateway = { emitToUser: jest.fn() };
    service = new CallCopilotUploadService(
      sessionModel as never,
      http as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      gridFs as never,
      reservations as never,
      copilot as never,
      gateway as never,
      { pushToDialer: jest.fn() } as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  /** Lets the background pipeline run through `polls` status checks. */
  async function runPipeline(polls = 1) {
    for (let i = 0; i < polls; i++) await jest.advanceTimersByTimeAsync(POLL_MS);
    await jest.advanceTimersByTimeAsync(0);
  }

  it('saves the recording, then its session, before anything goes to Sarvam — and keeps its language', async () => {
    const session = await service.startSessionFromRecording('org-1', 'user-1', Buffer.from([1]), 'plivo-rec.mp3', { languageCode: 'ta' });
    await runPipeline();
    expect(order.slice(0, 3)).toEqual(['gridfs.upload', 'session.create', 'sarvam.job']);
    expect(session.languageCode).toBe('ta');
    expect(copilot.endSession).toHaveBeenCalled();
    expect(copilot.errorSession).not.toHaveBeenCalled();
  });

  it('when credits are refused: marks the saved recording failed + retryable in words, and tells the caller', async () => {
    reservations.reserve.mockRejectedValueOnce(new HttpException({ code: 'INSUFFICIENT_BALANCE', message: 'x' }, HttpStatus.PAYMENT_REQUIRED));
    const session = makeSession();
    await expect(service.startProcessing(session as never, Buffer.from([1]))).rejects.toBeInstanceOf(HttpException);
    expect(session).toMatchObject({ status: 'error', retryable: true, errorMessage: expect.stringMatching(/HaiVE credits ran out/) });
    expect(gateway.emitToUser).not.toHaveBeenCalled(); // the uploader already gets the HTTP error
  });

  it("when Sarvam's job fails: the session says why, stays retryable, and the open page hears it", async () => {
    pollReplies.push(() => of({ data: { status: 'failed', segments: [], error: 'Audio file is corrupted' } }));
    const session = makeSession();
    await service.startProcessing(session as never, Buffer.from([1]));
    await runPipeline();
    expect(session).toMatchObject({ status: 'error', retryable: true, errorMessage: 'Sarvam AI couldn’t transcribe this recording: Audio file is corrupted.' });
    expect(gateway.emitToUser).toHaveBeenCalledWith('user-1', 'call:error', {
      sessionId: 'session-1',
      message: expect.stringContaining('Audio file is corrupted'),
    });
  });

  it('rides out python-agent restarting while Sarvam is still working on the job', async () => {
    pollReplies.push(
      () => refused('ECONNREFUSED'),
      () => refused('ECONNREFUSED'),
      () => refused('ECONNREFUSED'),
      () => of({ data: { status: 'processing', segments: [] } }),
    );
    const session = makeSession();
    await service.startProcessing(session as never, Buffer.from([1]));
    await runPipeline(5);
    expect(copilot.errorSession).not.toHaveBeenCalled();
    expect(copilot.endSession).toHaveBeenCalled();
  });

  it('says the AI service is down (not "status code 502") when it cannot take the recording', async () => {
    http.post.mockImplementation(() => refused('ECONNREFUSED'));
    const session = makeSession();
    await service.startProcessing(session as never, Buffer.from([1]));
    await runPipeline(0);
    expect(session.errorMessage).toMatch(/AI service isn’t running/);
    expect(session.retryable).toBe(true);
  });

  it('fails an empty transcript in words instead of ending a call with nothing in it', async () => {
    pollReplies.push(() => of({ data: { status: 'completed', segments: [{ sequence: 0, text: '  ' }] } }));
    const session = makeSession();
    await service.startProcessing(session as never, Buffer.from([1]));
    await runPipeline();
    expect(session.errorMessage).toMatch(/No speech was found/);
    expect(copilot.endSession).not.toHaveBeenCalled();
  });

  describe('retryProcessing', () => {
    const SESSION_ID = '6aedbd509785f97ab62528e4';
    const found = (session: Session) => sessionModel.findOne.mockReturnValue({ exec: async () => session });

    it('reprocesses the saved copy of a failed recording, under a fresh credit hold', async () => {
      found(makeSession({ status: 'error', errorMessage: 'old', retryable: true }));
      const claimed = makeSession({ status: 'processing', creditRequestId: 'credit-2' });
      sessionModel.findOneAndUpdate.mockReturnValue({ exec: async () => claimed });

      await service.retryProcessing('org-1', SESSION_ID, { userId: 'user-1' });
      await runPipeline();

      expect(gridFs.download).toHaveBeenCalledWith('call_recordings', 'file-1');
      const [filter, update] = sessionModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toMatchObject({ status: 'error', creditRequestId: 'credit-1' }); // a double click can't claim it twice
      expect(update.$set).toMatchObject({ status: 'processing', transcript: [] });
      expect(update.$set.creditRequestId).not.toBe('credit-1');
      expect(update.$unset).toMatchObject({ errorMessage: '', retryable: '' });
      expect(reservations.reserve).toHaveBeenCalledWith('org-1', 'user-1', 'credit-2', 'session-1');
      expect(copilot.endSession).toHaveBeenCalledWith(claimed);
    });

    it('refuses a call that is still being processed, or already done', async () => {
      found(makeSession({ status: 'processing', updatedAt: new Date() }));
      await expect(service.retryProcessing('org-1', SESSION_ID)).rejects.toBeInstanceOf(ConflictException);
      found(makeSession({ status: 'ended' }));
      await expect(service.retryProcessing('org-1', SESSION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(sessionModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('takes over a recording abandoned mid-way (the server restarted)', async () => {
      found(makeSession({ status: 'processing', updatedAt: new Date(Date.now() - 2 * 60 * 60_000) }));
      sessionModel.findOneAndUpdate.mockReturnValue({ exec: async () => makeSession() });
      await service.retryProcessing('org-1', SESSION_ID);
      expect(sessionModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ status: 'processing' });
    });

    it('never guesses the language of an older recording, but takes the phone call’s', async () => {
      found(makeSession({ status: 'error', languageCode: undefined }));
      await expect(service.retryProcessing('org-1', SESSION_ID)).rejects.toBeInstanceOf(BadRequestException);

      sessionModel.findOneAndUpdate.mockReturnValue({ exec: async () => makeSession({ languageCode: 'hi' }) });
      await service.retryProcessing('org-1', SESSION_ID, { languageCode: 'hi' });
      expect(sessionModel.findOneAndUpdate.mock.calls[0][1].$set.languageCode).toBe('hi');
    });

    it('says so when the saved recording is gone', async () => {
      found(makeSession({ status: 'error' }));
      gridFs.download.mockRejectedValueOnce(new Error('FileNotFound'));
      await expect(service.retryProcessing('org-1', SESSION_ID)).rejects.toThrow(/saved recording for this call is missing/);
    });
  });
});
