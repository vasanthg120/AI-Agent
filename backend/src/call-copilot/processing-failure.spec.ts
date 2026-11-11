import { HttpException, HttpStatus } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  NoSpeechFoundError,
  PROCESSING_ABANDONED_AFTER_MS,
  SarvamJobFailedError,
  TRANSCRIPTION_MAX_WAIT_MS,
  TranscriptionTimedOutError,
  describeProcessingFailure,
  isTransientAgentError,
} from './processing-failure';

const URL = 'http://localhost:8000/call-copilot/upload/transcribe-job';

function axiosError(options: { status?: number; code?: string; detail?: string }): AxiosError {
  const config = { url: `${URL}?x=1`, headers: new AxiosHeaders() };
  const response =
    options.status === undefined
      ? undefined
      : { status: options.status, statusText: '', headers: {}, config, data: options.detail ? { detail: options.detail } : 'Internal Server Error' };
  return new AxiosError(`Request failed with status code ${options.status ?? '-'}`, options.code, config, undefined, response as never);
}

describe('describeProcessingFailure — what the salesperson is told when a recording fails', () => {
  it("passes python-agent's own reason through (it is written for users), e.g. Sarvam out of credits", () => {
    const failure = describeProcessingFailure(
      axiosError({ status: 502, detail: 'Sarvam AI (speech-to-text) is out of credits. Top up the Sarvam account, then try again.' }),
    );
    expect(failure.message).toBe('Sarvam AI (speech-to-text) is out of credits. Top up the Sarvam account, then try again.');
    expect(failure.technical).toContain('HTTP 502');
    expect(failure.technical).not.toContain('?x=1'); // no query strings in logs
  });

  it('never shows the raw "Request failed with status code 502"', () => {
    const failure = describeProcessingFailure(axiosError({ status: 502 }));
    expect(failure.message).not.toMatch(/status code/i);
    expect(failure.message).toMatch(/AI service ran into a problem/);
  });

  it('says the AI service is not running when nothing answers on its port', () => {
    expect(describeProcessingFailure(axiosError({ code: 'ECONNREFUSED' })).message).toMatch(/AI service isn’t running/);
    expect(describeProcessingFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' })).message).toMatch(
      /AI service isn’t running/,
    );
  });

  it('says it was slow, not down, on a timeout', () => {
    expect(describeProcessingFailure(axiosError({ code: 'ECONNABORTED' })).message).toMatch(/took too long/);
  });

  it('points auth problems at an administrator', () => {
    expect(describeProcessingFailure(axiosError({ status: 401 })).message).toMatch(/administrator/);
  });

  it('names HaiVE credits running out (the reservation refusal)', () => {
    const err = new HttpException({ code: 'INSUFFICIENT_BALANCE', message: 'Your Haive Credits are exhausted.' }, HttpStatus.PAYMENT_REQUIRED);
    expect(describeProcessingFailure(err).message).toBe('Your HaiVE credits ran out before this call could be processed. Add credits, then try again.');
  });

  it("quotes Sarvam's own reason when its job fails", () => {
    expect(describeProcessingFailure(new SarvamJobFailedError('Audio file is corrupted')).message).toBe(
      'Sarvam AI couldn’t transcribe this recording: Audio file is corrupted.',
    );
  });

  it('explains a timeout and an empty transcript in plain words', () => {
    expect(describeProcessingFailure(new TranscriptionTimedOutError()).message).toMatch(/more than an hour/);
    expect(describeProcessingFailure(new NoSpeechFoundError()).message).toMatch(/No speech was found/);
  });

  it('falls back to a calm sentence, keeping the real reason for the log', () => {
    const failure = describeProcessingFailure(new Error('Cannot read properties of undefined'));
    expect(failure.message).toBe('Something went wrong while processing this call.');
    expect(failure.technical).toBe('Cannot read properties of undefined');
  });
});

describe('isTransientAgentError — status checks worth repeating while Sarvam works', () => {
  it('waits out python-agent restarting and gateway errors', () => {
    expect(isTransientAgentError(axiosError({ code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientAgentError(axiosError({ status: 503 }))).toBe(true);
    expect(isTransientAgentError(axiosError({ status: 502 }))).toBe(true);
  });

  it('does not repeat a refusal', () => {
    expect(isTransientAgentError(axiosError({ status: 401 }))).toBe(false);
    expect(isTransientAgentError(axiosError({ status: 404 }))).toBe(false);
    expect(isTransientAgentError(new Error('x'))).toBe(false);
  });
});

it('treats a session as abandoned only after a live pipeline would have given up', () => {
  expect(PROCESSING_ABANDONED_AFTER_MS).toBeGreaterThan(TRANSCRIPTION_MAX_WAIT_MS);
});
