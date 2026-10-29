import { BoxRenderable, TextareaRenderable } from "@opentui/core"
import type { EditBufferLike } from "./editor-bridge"

/** Private OpenCode 2.0.29 Prompt-tree adapter, NOT a slot SDK guarantee.
 * Prompt root -> input border box -> padding box -> textarea, alongside
 * root -> footer box -> this plugin's zero-size marker. No focus/ID/text
 * heuristic can replace this proof if the host changes its tree.
 */
type TreeNode = { parent: TreeNode | null; isDestroyed: boolean; getChildren(): TreeNode[] }
interface MarkerRecord { sessionID: string; marker: BoxRenderable }

export interface ComposerIdentity {
  register(sessionID: string, marker: BoxRenderable): void
  unregister(marker: BoxRenderable): void
  resolve(): EditBufferLike | null
  dispose(): void
}

function directChildren(node: TreeNode): TreeNode[] {
  return node.getChildren().filter((child) => child.parent === node && !child.isDestroyed)
}

function connectedToRenderer(node: TreeNode, rendererRoot: TreeNode): boolean {
  const visited = new Set<TreeNode>()
  let cursor: TreeNode | null = node
  while (cursor && !visited.has(cursor)) {
    if (cursor.isDestroyed) return false
    if (cursor === rendererRoot) return true
    visited.add(cursor)
    const parent: TreeNode | null = cursor.parent
    if (!parent || !directChildren(parent).includes(cursor)) return false
    cursor = parent
  }
  return false
}

function editorUnderMarker(marker: BoxRenderable, rendererRoot: TreeNode): TextareaRenderable | null {
  const markerNode = marker as unknown as TreeNode
  if (!connectedToRenderer(markerNode, rendererRoot)) return null
  const footer = markerNode.parent
  const promptRoot = footer?.parent
  if (!(footer instanceof BoxRenderable) || !(promptRoot instanceof BoxRenderable) ||
      !directChildren(footer).includes(markerNode) || !connectedToRenderer(promptRoot, rendererRoot)) return null

  // The footer and the input border are siblings; the padding box is a
  // direct border child and the textarea a direct padding child. Reject
  // ambiguity rather than choosing the first plausible editor.
  const candidates: TextareaRenderable[] = []
  for (const border of directChildren(promptRoot)) {
    if (!(border instanceof BoxRenderable) || border === footer) continue
    for (const padding of directChildren(border)) {
      if (!(padding instanceof BoxRenderable)) continue
      // The host also puts metadata (and optionally image attachments)
      // directly in this padding box. Only direct textarea children count.
      for (const child of directChildren(padding)) {
        if (child instanceof TextareaRenderable) candidates.push(child)
      }
    }
  }
  return candidates.length === 1 && connectedToRenderer(candidates[0], rendererRoot) ? candidates[0] : null
}

export function createComposerIdentity(context: unknown): ComposerIdentity {
  const markers = new Map<BoxRenderable, MarkerRecord>()
  const host = context as {
    renderer?: { root?: TreeNode; currentFocusedEditor?: unknown }
    ui?: { router?: { current(): { type: string; sessionID?: string } } }
  }
  return {
    register(sessionID, marker) {
      if (typeof sessionID === "string" && sessionID.length > 0) markers.set(marker, { sessionID, marker })
    },
    unregister(marker) { markers.delete(marker) },
    resolve() {
      try {
        // Solid refs are not nulled on OpenTUI destruction. Keep unattached
        // live refs (which may connect later); prune only destroyed markers.
        for (const marker of markers.keys()) {
          if (marker.isDestroyed) markers.delete(marker)
        }
        const route = host.ui?.router?.current()
        const rendererRoot = host.renderer?.root
        const focus = host.renderer?.currentFocusedEditor
        if (route?.type !== "session" || !route.sessionID || !rendererRoot || !focus) return null
        const candidates: TextareaRenderable[] = []
        for (const record of markers.values()) {
          if (record.sessionID !== route.sessionID) continue
          const editor = editorUnderMarker(record.marker, rendererRoot)
          if (editor) candidates.push(editor)
        }
        return candidates.length === 1 && candidates[0] === focus ? candidates[0] : null
      } catch {
        return null
      }
    },
    dispose() { markers.clear() },
  }
}
