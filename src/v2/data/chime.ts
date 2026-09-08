/**
 * THE SOUND AN ORDER MAKES, while somebody has the admin open.
 *
 * ═══════════════════ WHY THIS IS NOT PART OF THE NOTIFICATION ═══════════════
 * It cannot be. The Notifications API has NO sound parameter — not in Chrome,
 * not in Firefox, not in Safari; a `sound` field appeared in an old draft and
 * was never implemented anywhere. The tone a notification makes belongs to the
 * operating system and is not addressable from a page or a service worker.
 *
 * So the thing people mean by "loud like WhatsApp Web" is not a notification at
 * all — it is an open tab playing audio, which is exactly what this is. Two
 * different mechanisms for two different situations: this one covers the admin
 * being open, and the notification covers it being closed.
 *
 * ═══════════════════ SYNTHESISED, NOT A FILE ═══════════════════
 * An oscillator rather than an `<audio>` element and an mp3: no asset to ship,
 * nothing to 404, nothing to cache-bust, and no bytes on a phone connection —
 * for a sound that is two notes long. It also cannot be silenced by the service
 * worker's cache going stale, which a file could be.
 *
 * ═══════════════════ AUTOPLAY IS THE HARD PART ═══════════════════
 * Browsers refuse audio until the page has had a user gesture, and a context
 * created before one starts `suspended`. That is not an error to report: a
 * shop where the ping is silent for the first minute is fine, and a console
 * full of rejected promises is not. Every failure here is swallowed, and the
 * bell's own notification and the email are what actually carry the news.
 */

/** One context for the life of the page. Creating one per ping leaks handles —
 *  browsers cap them, and the cap is low enough to hit on a tab left open. */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    context ??= new Ctor();
    return context;
  } catch {
    return null;
  }
}

/**
 * Unlock the audio context from inside a user gesture.
 *
 * MUST BE CALLED FROM A REAL CLICK. A context created outside one begins
 * `suspended`, and `resume()` only succeeds while a gesture is being handled —
 * so this is wired to the same press that turns notifications on. After that
 * the context stays running for the life of the page and the ping works
 * whenever an order arrives, with no further interaction.
 */
export function unlockChime(): void {
  const ctx = audio();
  if (ctx === null) return;
  void ctx.resume().catch(() => undefined);
}

/**
 * Two rising notes, about a third of a second.
 *
 * DELIBERATELY SHORT AND UNALARMING. This fires on a paid order, which is good
 * news arriving during someone's working day, possibly several times an hour —
 * a long or urgent sound would be something they turn off within a week, and a
 * notification people switch off is worse than one that never existed.
 *
 * The gain envelope matters more than the notes: a bare oscillator starting and
 * stopping at full amplitude clicks audibly at both ends. Ramping up over 15ms
 * and decaying exponentially is what makes it a chime rather than a beep.
 */
export function playChime(): void {
  const ctx = audio();
  if (ctx === null) return;
  /*
   * Suspended means no gesture has unlocked it yet, and this ping is silent.
   *
   * `resume()` IS ASYNC, so there is no point re-checking the state on the next
   * line and playing anyway — it cannot have changed yet, and scheduling notes
   * against a suspended context queues them to fire whenever it wakes, which is
   * a chime for an order somebody dealt with an hour ago. Ask it to wake, drop
   * this one, and the next order rings properly.
   */
  if (ctx.state !== 'running') {
    void ctx.resume().catch(() => undefined);
    return;
  }

  try {
    const now = ctx.currentTime;
    /* E5 then A5 — a rising fourth, which reads as "something arrived" rather
       than as a warning. Sine waves: anything richer is piercing at the volume
       a notification wants to be. */
    for (const [i, freq] of [659.25, 880].entries()) {
      const at = now + i * 0.14;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      /* Peak well under 1: this plays over whatever else is on the machine, and
         a notification that dominates a call is one that gets muted. */
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    }
  } catch {
    /* An oscillator can throw on a context the browser has torn down (a
       backgrounded tab on iOS). Not worth a word to anybody. */
  }
}
