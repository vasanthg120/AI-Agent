import type { CoachNarration } from '@/services/callCopilotService';

// Plays the AI Coach's complete spoken narration: the report's parts in order,
// each turned into speech just before it is needed (the next part is prepared
// while this one plays), with pause, resume, stop and replay. The ONE player the
// AI Coach panel has: its speaker icon and its Speak Now button both drive it.
//
// One player belongs to one call in one language. Switching either destroys it
// (stopping its sound at once) and makes a new one, so a call's narration never
// plays for another call and a language never plays for another. Audio already
// made is kept for replays of the same narration, never across narrations.

export type NarrationStatus = 'idle' | 'preparing' | 'playing' | 'paused' | 'completed' | 'error';

export interface NarrationSnapshot {
  status: NarrationStatus;
  // The part being played (0-based) and how many there are; 0 until the narration is loaded.
  partIndex: number;
  partCount: number;
  // The report section being heard ("Skill breakdown").
  sectionTitle: string | null;
  // 0–1, by how much of the narration's text has been heard.
  progress: number;
  // Seconds heard so far, and the whole length once every part's length is known.
  elapsed: number;
  duration: number | null;
  // Waiting for the next part's audio while playing.
  buffering: boolean;
  error: string | null;
  // The element playing now, for the voice animation (never changes what is heard).
  audio: HTMLAudioElement | null;
}

export const IDLE_SNAPSHOT: NarrationSnapshot = {
  status: 'idle',
  partIndex: 0,
  partCount: 0,
  sectionTitle: null,
  progress: 0,
  elapsed: 0,
  duration: null,
  buffering: false,
  error: null,
  audio: null,
};

export interface NarrationPlayerDeps {
  /** The narration of this call's report in this player's language. */
  load: () => Promise<CoachNarration>;
  /** One part's speech. */
  speak: (text: string) => Promise<Blob>;
  /** Words for a failure. */
  describeError: (err: unknown) => string;
  createAudio?: (url: string) => HTMLAudioElement;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

// Only one narration speaks at a time on the page: starting one silences any other.
let active: CoachNarrationPlayer | null = null;

export class CoachNarrationPlayer {
  private narration: CoachNarration | null = null;
  private loading: Promise<CoachNarration> | null = null;
  private readonly speech = new Map<number, Promise<Blob>>();
  private readonly durations: (number | undefined)[] = [];
  private generation = 0;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private finishPart: (() => void) | null = null;
  private paused = false;
  private failedAt = 0;
  private destroyed = false;
  private snapshot: NarrationSnapshot = IDLE_SNAPSHOT;

  constructor(
    private readonly deps: NarrationPlayerDeps,
    private readonly onChange: (snapshot: NarrationSnapshot) => void,
  ) {}

  get state(): NarrationSnapshot {
    return this.snapshot;
  }

  /** Speak Now / the speaker icon: plays from the start, resumes a pause, or retries where it failed. */
  start(): void {
    if (this.destroyed) return;
    const { status } = this.snapshot;
    if (status === 'playing' || status === 'preparing') return; // a second click never starts a second voice
    if (status === 'paused') return this.resume();
    void this.playFrom(status === 'error' ? this.failedAt : 0);
  }

  pause(): void {
    if (this.snapshot.status !== 'playing') return;
    this.paused = true;
    this.audio?.pause();
    this.emit({ status: 'paused' });
  }

  resume(): void {
    if (this.snapshot.status !== 'paused') return;
    this.paused = false;
    this.claim();
    this.emit({ status: 'playing', error: null });
    if (this.audio) void this.startAudio(this.audio, this.generation);
  }

  /** Silence, back to the start; the audio already made is kept for a replay. */
  stop(): void {
    this.halt();
    this.emit({ ...IDLE_SNAPSHOT, partCount: this.narration?.parts.length ?? 0, duration: this.totalDuration() });
  }

  /** The whole narration again from the start. */
  replay(): void {
    this.halt();
    void this.playFrom(0);
  }

  /** For good: the call or the language changed, or the panel closed. */
  destroy(): void {
    this.halt();
    this.destroyed = true;
    this.speech.clear();
    if (active === this) active = null;
  }

  // ---- inside ----

  private halt(): void {
    this.generation += 1;
    this.paused = false;
    this.releaseAudio();
  }

  private claim(): void {
    if (active && active !== this) active.stop();
    active = this;
  }

  private emit(patch: Partial<NarrationSnapshot>): void {
    if (this.destroyed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }

  private releaseAudio(): void {
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      audio.onloadedmetadata = null;
      audio.pause();
      audio.removeAttribute('src');
    }
    if (this.url) (this.deps.revokeUrl ?? URL.revokeObjectURL)(this.url);
    this.url = null;
    // Lets a part that was playing finish its wait, so nothing is left pending.
    const finish = this.finishPart;
    this.finishPart = null;
    finish?.();
  }

  private async loadNarration(): Promise<CoachNarration> {
    if (this.narration) return this.narration;
    this.loading ??= this.deps.load().finally(() => {
      this.loading = null;
    });
    const narration = await this.loading;
    if (!narration.parts?.length) throw new Error('This AI Coach report has nothing to read out.');
    this.narration = narration;
    return narration;
  }

  private speechFor(index: number): Promise<Blob> {
    const parts = this.narration!.parts;
    let pending = this.speech.get(index);
    if (!pending) {
      pending = this.deps.speak(parts[index].text);
      // A failed part is asked for again next time, never remembered as failed.
      pending.catch(() => this.speech.delete(index));
      this.speech.set(index, pending);
    }
    return pending;
  }

  private totalDuration(): number | null {
    const count = this.narration?.parts.length ?? 0;
    if (count === 0) return null;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      const d = this.durations[i];
      if (d === undefined) return null;
      total += d;
    }
    return total;
  }

  private position(index: number, current: number, length: number): { progress: number; elapsed: number } {
    const parts = this.narration!.parts;
    const chars = parts.reduce((sum, p) => sum + p.text.length, 0) || 1;
    const before = parts.slice(0, index).reduce((sum, p) => sum + p.text.length, 0);
    const within = length > 0 && Number.isFinite(length) ? Math.min(1, current / length) : 0;
    const heard = this.durations.slice(0, index).reduce<number>((sum, d) => sum + (d ?? 0), 0);
    return { progress: Math.min(1, (before + parts[index].text.length * within) / chars), elapsed: heard + current };
  }

  private async playFrom(index: number): Promise<void> {
    this.claim();
    const generation = ++this.generation;
    this.paused = false;
    this.emit({ status: 'preparing', error: null, buffering: false, audio: null, partIndex: index, progress: index === 0 ? 0 : this.snapshot.progress, elapsed: index === 0 ? 0 : this.snapshot.elapsed });
    let current = index;
    try {
      const narration = await this.loadNarration();
      if (generation !== this.generation) return;
      const parts = narration.parts;
      this.emit({ partCount: parts.length, duration: this.totalDuration() });
      for (current = index; current < parts.length; current += 1) {
        const first = current === index;
        this.emit({ partIndex: current, sectionTitle: parts[current].title, ...(first ? {} : { buffering: true }) });
        const blob = await this.speechFor(current);
        if (generation !== this.generation) return;
        if (current + 1 < parts.length) void this.speechFor(current + 1).catch(() => undefined); // ready by the time it is needed
        await this.playPart(current, blob, generation);
        if (generation !== this.generation) return;
      }
      this.emit({ status: 'completed', progress: 1, buffering: false, audio: null, duration: this.totalDuration(), elapsed: this.totalDuration() ?? this.snapshot.elapsed });
      if (active === this) active = null;
    } catch (err) {
      if (generation !== this.generation) return;
      this.failedAt = current;
      this.releaseAudio();
      this.emit({ status: 'error', buffering: false, audio: null, error: this.deps.describeError(err) });
    }
  }

  private playPart(index: number, blob: Blob, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.releaseAudio();
      const url = (this.deps.createUrl ?? URL.createObjectURL)(blob);
      const audio = (this.deps.createAudio ?? ((src: string) => new Audio(src)))(url);
      this.url = url;
      this.audio = audio;
      this.finishPart = resolve;
      const measure = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) this.durations[index] = audio.duration;
      };
      audio.onloadedmetadata = measure;
      audio.ontimeupdate = () => {
        if (generation !== this.generation) return;
        this.emit(this.position(index, audio.currentTime, audio.duration));
      };
      audio.onended = () => {
        measure();
        // Done with: a Resume while the next part is still being prepared must not play this one again.
        this.finishPart = null;
        this.releaseAudio();
        this.emit({ audio: null });
        resolve();
      };
      audio.onerror = () => {
        this.finishPart = null;
        reject(new Error('This part of the narration could not be played. Try again.'));
      };
      if (this.paused) {
        // Paused while this part was being prepared: it waits, ready, for Resume.
        this.emit({ buffering: false, audio });
        return;
      }
      void this.startAudio(audio, generation);
    });
  }

  private async startAudio(audio: HTMLAudioElement, generation: number): Promise<void> {
    try {
      await audio.play();
      if (generation !== this.generation || audio !== this.audio) return;
      this.emit({ status: 'playing', buffering: false, audio });
    } catch (err) {
      if (generation !== this.generation || audio !== this.audio) return;
      const name = (err as { name?: string })?.name;
      // A pause pressed before the sound began: already paused, nothing to do.
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        // Browsers only allow sound after a click; a long wait for the first part can lose that permission.
        this.paused = true;
        this.emit({ status: 'paused', buffering: false, audio, error: 'Your browser held the sound back — press Resume to hear it.' });
        return;
      }
      // Audio the browser can't play: the part fails like any other playback error.
      audio.onerror?.call(audio, new Event('error'));
    }
  }
}
