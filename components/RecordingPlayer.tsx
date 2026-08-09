"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The inline player for a call recording.
 *
 * A custom transport rather than `<audio controls>`: the native widget brings
 * its own chrome — a different grey, a different corner radius and a download
 * button in Chrome — and it would sit inside a meeting card that is otherwise
 * built entirely from this app's tokens. Everything here is `bg-rail`,
 * `text-fg-3`, the accent, and the same 2.25rem control height as `.ui-btn`.
 *
 * The `<audio>` element is still doing all the work; it is just not drawing
 * anything. Its `src` is the authenticated stream route, so playback is a
 * series of ordinary same-origin range requests carrying the session cookie —
 * there is no blob to build, nothing to download first, and nothing cached to
 * disk by us.
 *
 * `preload="metadata"` is what fills in the duration without pulling the whole
 * call down: the browser asks for the head and tail of the file, which the
 * stream route answers with two small 206s.
 *
 * Transport state (position, duration, whether the last load failed) is
 * initial-value state, so the caller mounts this with `key={recording.id}`:
 * replacing a recording is a new player rather than an old one reset, and the
 * scrubber can never be left sitting at the previous file's position.
 */
export default function RecordingPlayer({
  src,
  /** Duration recorded at upload; shown until the element reports its own. */
  fallbackDuration,
  label,
}: {
  src: string;
  fallbackDuration: number | null;
  label: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState<number | null>(fallbackDuration);
  const [failed, setFailed] = useState(false);

  // Bound to the element's own events rather than mirrored in state on click:
  // playback can stop for reasons this component never hears about (the end of
  // the file, another tab taking the audio focus, the OS pausing media), and a
  // button that says "pause" over silence is worse than no button.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setCurrent(audio.currentTime);
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(0);
      audio.currentTime = 0;
    };
    const onError = () => {
      setFailed(true);
      setPlaying(false);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setFailed(true));
    else audio.pause();
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrent(value);
  }

  const total = duration ?? 0;
  const progress = total > 0 ? Math.min(current / total, 1) : 0;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-[image:var(--c-rail-fill)] px-2.5 py-1.5 shadow-[inset_0_1px_0_0_var(--c-highlight)]">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />

      {/* The transport button is the one filled thing in the player. It is
          accent-filled while playing and outlined while stopped, so the state
          is readable from the shape alone — not only from which glyph is in
          it, which is a 12px difference. */}
      <button
        type="button"
        onClick={toggle}
        disabled={failed}
        aria-label={`${playing ? "Pause" : "Play"} the call recording for ${label}`}
        className={`ui-btn h-7 w-7 shrink-0 rounded-full border !px-0 ${
          playing
            ? "border-transparent bg-accent text-on-accent shadow-[0_2px_10px_-3px_var(--c-accent)]"
            : "border-accent/50 text-accent hover:bg-accent hover:text-on-accent"
        }`}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <label className="min-w-0 flex-1">
        <span className="sr-only">Seek within the call recording for {label}</span>
        <input
          type="range"
          min={0}
          max={total > 0 ? total : 1}
          step={0.1}
          value={current}
          disabled={failed || total === 0}
          onChange={(event) => seek(Number(event.target.value))}
          // The track is painted with a gradient stop at the play position, so
          // elapsed reads as accent and the remainder as a hairline — the same
          // trick the stacked status bar uses, and it needs no pseudo-elements.
          style={{
            background: `linear-gradient(to right, var(--c-accent) ${progress * 100}%, var(--c-line-2) ${progress * 100}%)`,
          }}
          // The thumb carries a ring of the rail behind it and a soft accent
          // glow, so the playhead is findable on a 6px track without making
          // the track itself any taller.
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none transition-opacity disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:shadow-[0_0_0_2px_var(--c-rail),0_2px_8px_-2px_var(--c-accent)] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_var(--c-rail),0_2px_8px_-2px_var(--c-accent)] [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110"
        />
      </label>

      <span className="tnum shrink-0 font-mono text-meta text-fg-3">
        {failed ? "Unavailable" : `${formatClock(current)} / ${formatClock(total)}`}
      </span>
    </div>
  );
}

/** Seconds -> `m:ss`, or `h:mm:ss` once a call runs past the hour. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3">
      <path d="M4 2.6 9 6l-5 3.4z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3">
      <path d="M4 2.5h1.6v7H4zM6.9 2.5h1.6v7H6.9z" fill="currentColor" />
    </svg>
  );
}
