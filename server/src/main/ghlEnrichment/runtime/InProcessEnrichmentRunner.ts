/**
 * In-process, bounded-concurrency enrichment runner (JAK-197).
 *
 * Replaces the always-on BullMQ workers that drained the enrichment queues by
 * POLLING Redis 24/7 (bzpopmin/evalsha every ~second, ~500k Upstash requests/day
 * even with zero leads). Enrichment volume is low and webhook-triggered, so we do
 * NOT need a durable queue + a persistent consumer — we just need to run the same
 * (already BullMQ-free) processor asynchronously AFTER the webhook has returned its
 * fast 200.
 *
 * This runner is PURELY REACTIVE: it holds work in memory and processes it only
 * when {@link submit} is called. When idle it has no timers, no connections, and
 * touches Redis zero times — that is the whole point (idle Redis requests → 0).
 *
 * It preserves the guardrails the BullMQ queues gave us:
 *   - CONCURRENCY cap — at most {@link maxConcurrency} tasks run at once (the
 *     REAPI/GHL rate-limit budget); the rest wait in an in-memory FIFO.
 *   - TRANSIENT RETRY — a task that THROWS is retried with exponential backoff +
 *     jitter, up to {@link Task.attempts}. A {@link UnrecoverableError} is permanent
 *     and skips retries (same contract the processors already throw under). After
 *     the final attempt the optional {@link Task.onExhausted} hook runs (dead-letter
 *     / credit refund on the legacy path).
 *   - DEDUPE — an optional {@link Task.dedupeKey} (the contact id) collapses a
 *     re-fired contact onto the in-flight/queued one instead of double-processing,
 *     mirroring the old BullMQ `jobId` dedupe.
 *
 * Tradeoff vs BullMQ (accepted for low volume): retries live in memory, so a task
 * mid-backoff is dropped on a redeploy/crash. GHL re-delivers webhooks and the
 * work is idempotent (write-back overwrites), so this is safe here.
 */
import { UnrecoverableError } from "bullmq";
import { injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";

/** One unit of enrichment work handed to {@link InProcessEnrichmentRunner.submit}. */
export interface EnrichmentTask<T = unknown> {
  /**
   * The work. Receives the 1-based attempt number (the legacy worker records it on
   * its event row). RETURN to signal success; THROW to retry; throw
   * {@link UnrecoverableError} to fail permanently without retries.
   */
  run: (attempt: number) => Promise<T>;
  /** A short label for logs (e.g. "auto-enrichment loc/contact"). */
  label: string;
  /** Total attempts including the first. Defaults to the env retry policy. */
  attempts?: number;
  /** Base backoff (ms) for the exponential+jitter schedule. Defaults to env. */
  backoffMs?: number;
  /**
   * De-dupe key (the contact id). While a task with this key is queued or running,
   * a second submit with the same key is dropped. Omit to never dedupe.
   */
  dedupeKey?: string;
  /**
   * Terminal-failure hook: runs after the last attempt throws (or on a permanent
   * {@link UnrecoverableError}). Used by the legacy path to mark dead-letter +
   * refund. Its own errors are swallowed (logged) so one failure can't cascade.
   */
  onExhausted?: (err: unknown) => Promise<void> | void;
}

@injectable()
export class InProcessEnrichmentRunner {
  /** Hard ceiling on the in-memory backlog — a runaway producer can't OOM us. */
  private static readonly MAX_QUEUE = 10_000;
  /** Cap a single backoff so exponential growth can't wait absurdly long. */
  private static readonly BACKOFF_MAX_MS = 60_000;

  private readonly maxConcurrency: number;
  private readonly defaultAttempts: number;
  private readonly defaultBackoffMs: number;

  /** Tasks waiting for a concurrency slot (FIFO). */
  private readonly queue: EnrichmentTask[] = [];
  /** dedupeKeys currently queued or running (drop a duplicate submit). */
  private readonly inFlightKeys = new Set<string>();
  /** How many tasks are running right now. */
  private active = 0;

  constructor(env: EnvConfig) {
    // Reuse the SAME knobs the BullMQ auto-enrichment queue used, so the rate-limit
    // budget + retry policy are unchanged — only the transport (queue → in-memory).
    this.maxConcurrency = Math.max(1, env.autoEnrichConcurrency);
    this.defaultAttempts = Math.max(1, env.autoEnrichMaxAttempts);
    this.defaultBackoffMs = Math.max(1, env.autoEnrichBackoffMs);
  }

  /**
   * Queue a task to run asynchronously. Fire-and-forget: returns immediately (the
   * webhook has already answered 200), so a caller NEVER awaits enrichment. Returns
   * whether the task was accepted — `false` when deduped or the backlog is full
   * (both logged), so those never look like a silent success.
   */
  submit(task: EnrichmentTask): boolean {
    if (task.dedupeKey && this.inFlightKeys.has(task.dedupeKey)) {
      console.log(`⏭️ [enrichment-runner] dropped duplicate ${task.label} (in flight)`);
      return false;
    }
    if (this.queue.length >= InProcessEnrichmentRunner.MAX_QUEUE) {
      console.warn(
        `🚧 [enrichment-runner] backlog full (${InProcessEnrichmentRunner.MAX_QUEUE}) — dropping ${task.label}`
      );
      return false;
    }
    if (task.dedupeKey) this.inFlightKeys.add(task.dedupeKey);
    this.queue.push(task);
    this.pump();
    return true;
  }

  /** True while any task is queued or running (used by tests / graceful drain). */
  get busy(): boolean {
    return this.active > 0 || this.queue.length > 0;
  }

  /** Start as many queued tasks as the concurrency budget allows. */
  private pump(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active++;
      // Detached on purpose — the webhook already responded. runTask never rejects.
      void this.runTask(task).finally(() => {
        this.active--;
        if (task.dedupeKey) this.inFlightKeys.delete(task.dedupeKey);
        this.pump();
      });
    }
  }

  /**
   * Run one task to a terminal state: success, permanent failure, or retries
   * exhausted. NEVER rejects — a task failure only fails that task. Mirrors the
   * BullMQ retry contract (throw = retry with backoff; UnrecoverableError = stop).
   */
  private async runTask(task: EnrichmentTask): Promise<void> {
    const attempts = task.attempts ?? this.defaultAttempts;
    const backoffMs = task.backoffMs ?? this.defaultBackoffMs;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await task.run(attempt);
        return;
      } catch (err) {
        const permanent = err instanceof UnrecoverableError;
        const lastAttempt = attempt >= attempts;
        if (permanent || lastAttempt) {
          console.error(
            `💥 [enrichment-runner] ${task.label} ${permanent ? "permanently failed" : `failed after ${attempt} attempt(s)`}: ${this.message(err)}`
          );
          await this.runExhausted(task, err);
          return;
        }
        const wait = this.backoff(attempt, backoffMs);
        console.warn(
          `🔁 [enrichment-runner] ${task.label} attempt ${attempt}/${attempts} failed — retrying in ${wait}ms`
        );
        await this.delay(wait);
      }
    }
  }

  /** Run the dead-letter hook, swallowing its own errors so nothing cascades. */
  private async runExhausted(task: EnrichmentTask, err: unknown): Promise<void> {
    if (!task.onExhausted) return;
    try {
      await task.onExhausted(err);
    } catch (hookErr) {
      console.error(
        `❌ [enrichment-runner] onExhausted for ${task.label} threw: ${this.message(hookErr)}`
      );
    }
  }

  /**
   * Exponential backoff with additive jitter, capped. `base·2^(attempt-1)` plus up
   * to one base interval of jitter so simultaneous retries don't march in lockstep.
   */
  private backoff(attempt: number, base: number): number {
    const exponential = base * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * base);
    return Math.min(exponential + jitter, InProcessEnrichmentRunner.BACKOFF_MAX_MS);
  }

  /** Overridable sleep — a seam so tests can run retries without real timers. */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
