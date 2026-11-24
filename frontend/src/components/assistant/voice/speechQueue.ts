import { voiceService } from '@/services/voiceService';

// Speaks text the way a person would: sentence by sentence, starting as soon as
// the first sentence is ready (the next one is prepared while this one plays),
// and stops at once when interrupted. Every sentence goes through the person's
// own Voice & Accent setting (POST /voice/speak), so the assistant has no voice
// setting of its own.

/** Markdown and on-screen-only parts (tables, code, links) out; plain words in. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/[>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Long enough to sound natural, short enough to start quickly; never over the speech limit (2,500).
const MIN_CHUNK = 40;
const MAX_CHUNK = 400;

/** Sentences, joined into chunks of a natural length. */
export function sentenceChunks(text: string): string[] {
  const sentences = speakable(text).match(/[^.!?।]+[.!?।]+["')\]]*|\S[^.!?।]*$/g) ?? [];
  const chunks: string[] = [];
  let current = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (!current) current = sentence;
    else if (current.length < MIN_CHUNK || current.length + sentence.length + 1 <= MAX_CHUNK / 2) current = `${current} ${sentence}`;
    else {
      chunks.push(current);
      current = sentence;
    }
    while (current.length > MAX_CHUNK) {
      const cut = current.lastIndexOf(' ', MAX_CHUNK);
      chunks.push(current.slice(0, cut > 0 ? cut : MAX_CHUNK));
      current = current.slice(cut > 0 ? cut + 1 : MAX_CHUNK);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class SpeechQueue {
  private queue: string[] = [];
  private running = false;
  private generation = 0;
  private audio: HTMLAudioElement | null = null;

  constructor(
    private readonly language: () => string,
    private readonly onSpeakingChange: (speaking: boolean) => void,
    private readonly onError?: (message: string) => void,
    // Each sentence as it starts playing (its words and its audio); null when Haive stops talking.
    private readonly onSentence?: (text: string | null, audio: HTMLAudioElement | null) => void,
  ) {}

  get speaking(): boolean {
    return this.running;
  }

  /** Adds text to what is being said (split into sentences); starts speaking if quiet. */
  say(text: string): void {
    const chunks = sentenceChunks(text);
    if (chunks.length === 0) return;
    this.queue.push(...chunks);
    if (!this.running) void this.run(this.generation);
  }

  /** Stops speaking at once and forgets what was still to say. */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.running) {
      this.running = false;
      this.onSentence?.(null, null);
      this.onSpeakingChange(false);
    }
  }

  private fetch(text: string): Promise<{ text: string; blob: Blob } | null> {
    return voiceService
      .speak(text, this.language())
      .then((blob) => ({ text, blob }))
      .catch((err: unknown) => {
        this.onError?.(err instanceof Error ? err.message : 'Couldn’t speak that.');
        return null;
      });
  }

  private play(blob: Blob, generation: number, text: string): Promise<void> {
    return new Promise((resolve) => {
      if (generation !== this.generation) return resolve();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.onpause = () => {
        if (generation !== this.generation) done();
      };
      audio
        .play()
        .then(() => {
          if (generation === this.generation) this.onSentence?.(text, audio);
        })
        .catch(() => {
          this.onError?.('The browser blocked sound — tap the speaker to hear it.');
          done();
        });
    });
  }

  private async run(generation: number): Promise<void> {
    this.running = true;
    this.onSpeakingChange(true);
    let next: Promise<{ text: string; blob: Blob } | null> | null = this.queue.length ? this.fetch(this.queue.shift()!) : null;
    while (next && generation === this.generation) {
      const spoken = await next;
      if (generation !== this.generation) return;
      // The next sentence is prepared while this one plays.
      const following = this.queue.length ? this.fetch(this.queue.shift()!) : null;
      if (spoken) await this.play(spoken.blob, generation, spoken.text);
      if (generation !== this.generation) return;
      next = following ?? (this.queue.length ? this.fetch(this.queue.shift()!) : null);
    }
    if (generation === this.generation) {
      this.running = false;
      this.audio = null;
      this.onSentence?.(null, null);
      this.onSpeakingChange(false);
    }
  }
}
