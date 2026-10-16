// Reactive-free suggestion state for opencode-history-ghost (T6, DESIGN §3.4).
//
// REACTIVITY DECISION (defect-1 fix): this plugin's node_modules carries
// parasitic local copies of solid-js / @opentui/solid, and the OpenCode host
// (v2.0.29) only substitutes its own module instances reliably for hoisted
// imports of a precompiled single-file bundle (usage-meter pitfalls #13/#16,
// real-machine verified across 0.7.18-0.7.25). Under the current packaging a
// plugin-side createSignal lands on the parasitic module graph, whose render
// effects never register with the host slot machinery — the drawn tree freezes
// at the mount-time snapshot. This store therefore keeps NO solid primitive:
// state is a plain object plus an explicit change-listener set. Consumers
// (ghost line) patch the renderable tree imperatively and schedule
// renderer.requestRender() — a configuration-agnostic pipeline proven by
// usage-meter 0.7.11+ ("the tree flips; the screen paints when someone asks").
//
// evaluate() owns four layers, in order:
//   0. single normalization — the raw editor text is trimmed ONCE at the
//      entry; state.input, the fast-path comparison, and the ghost line's
//      highlight slicing all use the trimmed value, so "帮我 " highlights and
//      extends exactly like "帮我" (matcher already trims internally, accept
//      still replaces with the candidate's original text),
//   1. dismiss recovery — Esc only suppresses the exact input it dismissed;
//      any other input re-arms suggestions immediately,
//   2. defensive gating — plugin disabled / empty / too short / excluded
//      prefixes never reach the matcher,
//   3. incremental fast path (fish-shell anti-flicker) — when the new input
//      is a one-way extension of the old one and the currently shown
//      candidate still starts with it, keep the candidate list and cycle
//      index and only move `input`; the matcher does not re-run.

import type { HistoryEntry } from "./history-source"
import { findCandidates } from "./matcher"

/**
 * Persisted plugin settings (DESIGN §3.8). At runtime this is the reactive
 * store returned by context.storage.store("history-ghost-settings", ...), or
 * a plain in-memory default object when the storage API is unavailable;
 * fields stay mutable so the toggle command can write through.
 */
export interface HistoryGhostSettings {
  /** Master switch (palette command "History Ghost: 开关历史建议"). */
  enabled: boolean
  /** Key that accepts the suggestion: "tab" (default), "right", "ctrl+y", ...
   * consumed by the keymap layer as the accept command's bind. */
  acceptKey: string
  /** Minimum typed length (after trim) before suggestions appear. */
  minChars: number
  /** Maximum candidates kept per evaluation. */
  maxCandidates: number
  /** History entries loaded from the data sources. */
  maxEntries: number
  /** Entries longer than this are never suggested (paste protection). */
  maxTextLength: number
  /** Inputs starting with any of these prefixes produce no suggestion. */
  excludePrefixes: string[]
}

export interface SuggestionState {
  /** The TRIMMED input that produced the current candidate list. */
  readonly input: string
  /** Ordered candidates (matcher output); `index` selects the shown one. */
  readonly candidates: HistoryEntry[]
  /** Ring index into candidates; 0 after a fresh evaluation. */
  readonly index: number
}

export interface SuggestionStoreApi {
  /** Re-runs the suggestion pipeline for the given raw editor text. */
  evaluate(rawInput: string): void
  /** Moves the candidate ring by one step (ctrl+down / ctrl+up). */
  cycle(direction: 1 | -1): void
  /** Drops the suggestion without recording a dismissal (post-accept). */
  clear(): void
  /** Drops the suggestion and suppresses it for the exact same input (Esc). */
  dismiss(): void
  /** The currently shown candidate, or null. */
  current(): HistoryEntry | null
  /** True while a suggestion is visible; drives the keymap layer's enabled. */
  hasSuggestion(): boolean
  /** Full-state read; patch consumers call this inside refresh(). */
  state(): SuggestionState | null
  /**
   * Subscribes to state changes (fired after every committed mutation);
   * the return value unsubscribes. The imperative UI pipeline hooks in here.
   */
  onStateChange(listener: () => void): () => void
}

export function createSuggestionStore(
  history: () => HistoryEntry[],
  settings: HistoryGhostSettings,
): SuggestionStoreApi {
  let currentState: SuggestionState | null = null
  /** Input the user explicitly dismissed; re-arms as soon as the input differs. */
  let dismissedForInput: string | null = null
  const stateChangeListeners = new Set<() => void>()

  /** Commits the next state and notifies every listener, each guarded. */
  function commitState(nextState: SuggestionState | null): void {
    if (currentState === nextState) return
    currentState = nextState
    for (const stateChangeListener of stateChangeListeners) {
      try {
        stateChangeListener()
      } catch (error) {
        console.warn("[opencode-history-ghost] a state-change listener failed:", error)
      }
    }
  }

  return {
    evaluate(rawInput: string): void {
      try {
        if (!settings.enabled) {
          commitState(null)
          return
        }
        const trimmedInput = rawInput.trim()
        if (trimmedInput.length === 0 || trimmedInput.length < settings.minChars) {
          commitState(null)
          return
        }
        for (const excludePrefix of settings.excludePrefixes) {
          if (excludePrefix && trimmedInput.startsWith(excludePrefix)) {
            commitState(null)
            return
          }
        }
        if (dismissedForInput !== null) {
          if (dismissedForInput === trimmedInput) {
            commitState(null)
            return
          }
          // The input changed after Esc — suggestions come back (DESIGN §4).
          dismissedForInput = null
        }
        const previousState = currentState
        if (previousState) {
          // Nothing changed (e.g. a repeated event): keep the current line.
          if (previousState.input === trimmedInput) return
          const shownCandidate = previousState.candidates[previousState.index]
          const inputOnlyExtended =
            trimmedInput.length > previousState.input.length && trimmedInput.startsWith(previousState.input)
          if (
            shownCandidate &&
            inputOnlyExtended &&
            shownCandidate.lower.startsWith(trimmedInput.toLowerCase())
          ) {
            // Fast path: the typed text still prefixes the shown candidate —
            // keep list and index, only move `input` (anti-flicker).
            commitState({ input: trimmedInput, candidates: previousState.candidates, index: previousState.index })
            return
          }
        }
        const candidates = findCandidates(history(), trimmedInput, {
          minChars: settings.minChars,
          maxCandidates: settings.maxCandidates,
          excludePrefixes: settings.excludePrefixes,
        })
        commitState(candidates.length === 0 ? null : { input: trimmedInput, candidates, index: 0 })
      } catch (error) {
        console.warn("[opencode-history-ghost] suggestion evaluation failed:", error)
        commitState(null)
      }
    },
    cycle(direction: 1 | -1): void {
      const storeState = currentState
      if (!storeState || storeState.candidates.length === 0) return
      const candidateCount = storeState.candidates.length
      const nextIndex = (storeState.index + direction + candidateCount) % candidateCount
      commitState({ ...storeState, index: nextIndex })
    },
    clear(): void {
      commitState(null)
    },
    dismiss(): void {
      const storeState = currentState
      if (!storeState) return
      dismissedForInput = storeState.input
      commitState(null)
    },
    current(): HistoryEntry | null {
      const storeState = currentState
      if (!storeState) return null
      return storeState.candidates[storeState.index] ?? null
    },
    hasSuggestion(): boolean {
      return currentState !== null && currentState.candidates.length > 0
    },
    state(): SuggestionState | null {
      return currentState
    },
    onStateChange(listener: () => void): () => void {
      stateChangeListeners.add(listener)
      return () => {
        stateChangeListeners.delete(listener)
      }
    },
  }
}
