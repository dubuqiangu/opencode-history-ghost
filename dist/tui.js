// src/tui.tsx
import * as fs3 from "node:fs";
import { Plugin } from "@opencode/plugin/tui";

// src/history-source.ts
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
var DEFAULT_MAX_HISTORY_ENTRIES = 2e3;
var DEFAULT_MAX_TEXT_LENGTH = 2e3;
var MIN_FILTERED_TEXT_LENGTH = 2;
var DEFAULT_OPENCODE_DATA_DIR = nodePath.join(nodeOs.homedir(), ".local", "share", "opencode");
var DEFAULT_PROMPT_HISTORY_JSONL_PATH = nodePath.join(
  nodeOs.homedir(),
  ".local",
  "state",
  "opencode",
  "prompt-history.jsonl"
);
function createHistorySource(options = {}) {
  return new SqliteAndJsonlHistorySource(options);
}
var SqliteAndJsonlHistorySource = class {
  databaseDirectory;
  promptHistoryJsonlPath;
  maxEntries;
  maxTextLength;
  readyPromise;
  jsonlTexts = [];
  databaseTexts = [];
  mergedEntries = [];
  lastJsonlMtimeMs = null;
  jsonlReadCount = 0;
  databaseLoadCount = 0;
  hasWarnedDegraded = false;
  constructor(options) {
    this.maxEntries = toNonNegativeIntegerOr(options.maxEntries, DEFAULT_MAX_HISTORY_ENTRIES);
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    if (options.dataDirOverride !== void 0) {
      this.databaseDirectory = options.dataDirOverride;
      this.promptHistoryJsonlPath = nodePath.join(options.dataDirOverride, "prompt-history.jsonl");
    } else {
      this.databaseDirectory = DEFAULT_OPENCODE_DATA_DIR;
      this.promptHistoryJsonlPath = DEFAULT_PROMPT_HISTORY_JSONL_PATH;
    }
    this.reloadJsonl();
    this.readyPromise = this.loadDatabaseInBackground();
  }
  entries() {
    return this.mergedEntries;
  }
  refresh() {
    const currentMtimeMs = statMtimeMsOrNull(this.promptHistoryJsonlPath);
    if (currentMtimeMs === this.lastJsonlMtimeMs) return;
    this.reloadJsonl();
  }
  whenReady() {
    return this.readyPromise;
  }
  readStats() {
    return { jsonlReads: this.jsonlReadCount, databaseLoads: this.databaseLoadCount };
  }
  async loadDatabaseInBackground() {
    const databaseFilePath = resolveDatabaseFilePath(this.databaseDirectory);
    if (databaseFilePath === null) {
      this.warnDegradedOnce(`\u672A\u627E\u5230 opencode DB\uFF08\u67E5\u627E\u76EE\u5F55\uFF1A${this.databaseDirectory}\uFF09\uFF0C\u964D\u7EA7 jsonl-only`);
      return;
    }
    const openOutcome = await openSqliteReadonly(databaseFilePath);
    if (openOutcome.database === null) {
      this.warnDegradedOnce(
        `opencode DB \u65E0\u6CD5\u6253\u5F00\uFF08bun:sqlite \u4E0E node:sqlite \u5747\u4E0D\u53EF\u7528\uFF1A${databaseFilePath}\uFF1B\u5E95\u5C42\u539F\u56E0\uFF1A${openOutcome.failureSummary}\uFF09\uFF0C\u964D\u7EA7 jsonl-only`
      );
      return;
    }
    const database = openOutcome.database;
    try {
      this.databaseTexts = await readUserTextsFromDatabase(database, this.maxEntries, this.maxTextLength);
      this.databaseLoadCount += 1;
      this.rebuildMergedEntries();
    } catch (queryError) {
      this.warnDegradedOnce(`opencode DB schema \u4E0D\u9002\u914D\uFF08${String(queryError)}\uFF09\uFF0C\u964D\u7EA7 jsonl-only`);
    } finally {
      try {
        database.close();
      } catch {
      }
    }
  }
  reloadJsonl() {
    this.jsonlReadCount += 1;
    let jsonlTexts = [];
    let jsonlMtimeMs = null;
    try {
      const jsonlContent = nodeFs.readFileSync(this.promptHistoryJsonlPath, "utf8");
      jsonlMtimeMs = statMtimeMsOrNull(this.promptHistoryJsonlPath);
      jsonlTexts = parseJsonlTextsNewestFirst(jsonlContent);
    } catch {
    }
    this.jsonlTexts = jsonlTexts;
    this.lastJsonlMtimeMs = jsonlMtimeMs;
    this.rebuildMergedEntries();
  }
  rebuildMergedEntries() {
    const seenTexts = /* @__PURE__ */ new Set();
    const mergedEntries = [];
    for (const text of this.jsonlTexts) {
      if (mergedEntries.length >= this.maxEntries) break;
      this.appendFilteredEntry(text, seenTexts, mergedEntries);
    }
    for (const text of this.databaseTexts) {
      if (mergedEntries.length >= this.maxEntries) break;
      this.appendFilteredEntry(text, seenTexts, mergedEntries);
    }
    if (mergedEntries.length === this.mergedEntries.length && mergedEntries.every((entry, index) => entry.text === this.mergedEntries[index].text)) return;
    this.mergedEntries = mergedEntries;
  }
  appendFilteredEntry(text, seenTexts, mergedEntries) {
    const normalizedText = normalizeLineEndings(text);
    const trimmedText = normalizedText.trim();
    if (seenTexts.has(trimmedText)) return;
    if (!passesHistoryTextFilter(trimmedText, this.maxTextLength)) return;
    seenTexts.add(trimmedText);
    mergedEntries.push({ text: trimmedText, lower: trimmedText.toLowerCase() });
  }
  warnDegradedOnce(message) {
    if (this.hasWarnedDegraded) return;
    this.hasWarnedDegraded = true;
    console.warn(`[opencode-history-ghost] ${message}`);
  }
};
function resolveDatabaseFilePath(databaseDirectory) {
  const environmentDatabasePath = process.env["OPENCODE_DB"];
  if (environmentDatabasePath !== void 0 && environmentDatabasePath.trim().length > 0) {
    return environmentDatabasePath;
  }
  const primaryDatabasePath = nodePath.join(databaseDirectory, "opencode.db");
  if (fileExists(primaryDatabasePath)) return primaryDatabasePath;
  return findNewestDatabaseInDirectory(databaseDirectory);
}
function findNewestDatabaseInDirectory(databaseDirectory) {
  let directoryEntries;
  try {
    directoryEntries = nodeFs.readdirSync(databaseDirectory);
  } catch {
    return null;
  }
  let newestDatabasePath = null;
  let newestMtimeMs = -1;
  for (const fileName of directoryEntries) {
    if (!fileName.startsWith("opencode") || !fileName.endsWith(".db")) continue;
    const candidatePath = nodePath.join(databaseDirectory, fileName);
    try {
      const candidateStats = nodeFs.statSync(candidatePath);
      if (candidateStats.isFile() && candidateStats.mtimeMs > newestMtimeMs) {
        newestMtimeMs = candidateStats.mtimeMs;
        newestDatabasePath = candidatePath;
      }
    } catch {
    }
  }
  return newestDatabasePath;
}
async function openSqliteReadonly(databaseFilePath) {
  const backendFailureReasons = [];
  try {
    const bunSqliteModule = await import("bun:sqlite");
    return { database: new bunSqliteModule.Database(databaseFilePath, { readonly: true }), failureSummary: void 0 };
  } catch (bunSqliteError) {
    backendFailureReasons.push(`bun:sqlite \u2192 ${describeUnderlyingError(bunSqliteError)}`);
  }
  try {
    const nodeSqliteModule = await import("node:sqlite");
    return {
      database: new nodeSqliteModule.DatabaseSync(databaseFilePath, { readOnly: true }),
      failureSummary: void 0
    };
  } catch (nodeSqliteError) {
    backendFailureReasons.push(`node:sqlite \u2192 ${describeUnderlyingError(nodeSqliteError)}`);
    return { database: null, failureSummary: backendFailureReasons.join("\uFF1B") };
  }
}
function describeUnderlyingError(error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const truncatedLength = 160;
  if (rawMessage.length <= truncatedLength) return rawMessage;
  return `${rawMessage.slice(0, truncatedLength)}\u2026`;
}
async function readUserTextsFromDatabase(database, maxEntries, maxTextLength) {
  if (maxEntries === 0) return [];
  const retainedTexts = [];
  const seenTexts = /* @__PURE__ */ new Set();
  const sources = [
    {
      firstPageSql: "SELECT data, time_created AS sortTime, rowid AS messageRowId FROM session_message WHERE type = 'user' AND time_created IS NOT NULL ORDER BY time_created DESC, rowid DESC LIMIT ?",
      nextPageSql: `SELECT data, time_created AS sortTime, rowid AS messageRowId FROM session_message
        WHERE type = 'user' AND (time_created, rowid) < (?, ?)
        ORDER BY time_created DESC, rowid DESC LIMIT ?`,
      firstNullPageSql: `SELECT data, time_created AS sortTime, rowid AS messageRowId FROM session_message
        WHERE type = 'user' AND time_created IS NULL ORDER BY time_created DESC, rowid DESC LIMIT ?`,
      nullTimePageSql: `SELECT data, time_created AS sortTime, rowid AS messageRowId FROM session_message
        WHERE type = 'user' AND time_created IS NULL AND rowid < ?
        ORDER BY time_created DESC, rowid DESC LIMIT ?`,
      column: "data",
      extract: extractTextFromSessionMessageData,
      hasPartRowId: false
    },
    {
      firstPageSql: `SELECT part.data AS partData, message.time_created AS sortTime,
          message.rowid AS messageRowId, part.rowid AS partRowId FROM message
        JOIN part ON part.message_id = message.id
        WHERE message.data LIKE '%"role":"user"%' AND message.time_created IS NOT NULL
        ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC
        LIMIT ?`,
      nextPageSql: `SELECT part.data AS partData, message.time_created AS sortTime,
          message.rowid AS messageRowId, part.rowid AS partRowId FROM message
        JOIN part ON part.message_id = message.id
        WHERE message.data LIKE '%"role":"user"%' AND
          (message.time_created, message.rowid, part.rowid) < (?, ?, ?)
        ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ?`,
      firstNullPageSql: `SELECT part.data AS partData, message.time_created AS sortTime,
          message.rowid AS messageRowId, part.rowid AS partRowId FROM message
        JOIN part ON part.message_id = message.id
        WHERE message.data LIKE '%"role":"user"%' AND message.time_created IS NULL
        ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ?`,
      nullTimePageSql: `SELECT part.data AS partData, message.time_created AS sortTime,
          message.rowid AS messageRowId, part.rowid AS partRowId FROM message
        JOIN part ON part.message_id = message.id
        WHERE message.data LIKE '%"role":"user"%' AND message.time_created IS NULL AND
          (message.rowid, part.rowid) < (?, ?)
        ORDER BY message.time_created DESC, message.rowid DESC, part.rowid DESC LIMIT ?`,
      column: "partData",
      extract: extractTextFromLegacyPartData,
      hasPartRowId: true
    }
  ];
  let successfulSources = 0;
  let lastSourceError;
  for (const source of sources) {
    if (seenTexts.size >= maxEntries) break;
    const retainedCountBeforeSource = retainedTexts.length;
    const preparedStatements = [];
    try {
      const prepareTracked = (sql) => {
        const statement = database.prepare(sql);
        preparedStatements.push(statement);
        return statement;
      };
      const firstPage = prepareTracked(source.firstPageSql);
      const nextPage = prepareTracked(source.nextPageSql);
      const firstNullPage = prepareTracked(source.firstNullPageSql);
      const nullTimePage = prepareTracked(source.nullTimePageSql);
      let cursor = null;
      let scanningNullTimes = false;
      const pageSize = 256;
      while (seenTexts.size < maxEntries) {
        const rows = scanningNullTimes ? cursor === null ? firstNullPage.all(pageSize) : source.hasPartRowId ? nullTimePage.all(cursor.messageRowId, cursor.partRowId, pageSize) : nullTimePage.all(cursor.messageRowId, pageSize) : cursor === null ? firstPage.all(pageSize) : source.hasPartRowId ? nextPage.all(cursor.sortTime, cursor.messageRowId, cursor.partRowId, pageSize) : nextPage.all(cursor.sortTime, cursor.messageRowId, pageSize);
        if (rows.length === 0) {
          if (!scanningNullTimes) {
            scanningNullTimes = true;
            cursor = null;
            await yieldToEventLoop();
            continue;
          }
          break;
        }
        const lastRow = rows[rows.length - 1];
        cursor = { sortTime: lastRow["sortTime"], messageRowId: lastRow["messageRowId"], partRowId: lastRow["partRowId"] };
        for (const row of rows) {
          const extractedText = source.extract(row[source.column]);
          if (extractedText === null) continue;
          const normalizedText = normalizeLineEndings(extractedText).trim();
          if (seenTexts.has(normalizedText) || !passesHistoryTextFilter(normalizedText, maxTextLength)) continue;
          seenTexts.add(normalizedText);
          retainedTexts.push(normalizedText);
          if (seenTexts.size >= maxEntries) break;
        }
        if (rows.length < pageSize && !scanningNullTimes) {
          scanningNullTimes = true;
          cursor = null;
          if (seenTexts.size < maxEntries) await yieldToEventLoop();
          continue;
        }
        if (rows.length < pageSize) break;
        if (seenTexts.size < maxEntries) await yieldToEventLoop();
      }
      successfulSources += 1;
    } catch (sourceError) {
      for (const text of retainedTexts.splice(retainedCountBeforeSource)) seenTexts.delete(text);
      lastSourceError = sourceError;
    } finally {
      for (const statement of preparedStatements) {
        try {
          statement.finalize?.();
        } catch {
        }
      }
    }
  }
  if (successfulSources === 0) throw lastSourceError;
  return retainedTexts;
}
function extractTextFromSessionMessageData(rawColumnValue) {
  let messageData = rawColumnValue;
  if (typeof messageData === "string") {
    try {
      messageData = JSON.parse(messageData);
    } catch {
      return null;
    }
  }
  if (messageData === null || typeof messageData !== "object") return null;
  const messageRecord = messageData;
  if (Array.isArray(messageRecord["parts"])) {
    const joinedPartsText = messageRecord["parts"].map((part) => part !== null && typeof part === "object" && typeof part["text"] === "string" ? part["text"] : "").join("");
    if (joinedPartsText.trim().length > 0) return joinedPartsText;
  }
  if (typeof messageRecord["text"] === "string" && messageRecord["text"].trim().length > 0) {
    return messageRecord["text"];
  }
  return null;
}
function extractTextFromLegacyPartData(rawColumnValue) {
  let partData = rawColumnValue;
  if (typeof partData === "string") {
    try {
      partData = JSON.parse(partData);
    } catch {
      return null;
    }
  }
  if (partData === null || typeof partData !== "object") return null;
  const partRecord = partData;
  if (partRecord["type"] !== "text") return null;
  if (typeof partRecord["text"] === "string" && partRecord["text"].trim().length > 0) {
    return partRecord["text"];
  }
  return null;
}
function parseJsonlTextsNewestFirst(jsonlContent) {
  const jsonlLines = jsonlContent.split(/\r?\n/);
  const promptTexts = [];
  for (let lineIndex = jsonlLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const trimmedLine = jsonlLines[lineIndex].trim();
    if (trimmedLine.length === 0) continue;
    try {
      const promptInfo = JSON.parse(trimmedLine);
      if (typeof promptInfo["text"] === "string") promptTexts.push(promptInfo["text"]);
    } catch {
    }
  }
  return promptTexts;
}
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}
function toNonNegativeIntegerOr(rawLimit, fallbackLimit) {
  if (rawLimit === void 0) return fallbackLimit;
  if (!Number.isFinite(rawLimit) || rawLimit < 0) return fallbackLimit;
  return Math.floor(rawLimit);
}
function passesHistoryTextFilter(text, maxTextLength) {
  const trimmedText = text.trim();
  if (trimmedText.length < MIN_FILTERED_TEXT_LENGTH) return false;
  if (trimmedText.length > maxTextLength) return false;
  if (trimmedText.startsWith("/")) return false;
  return true;
}
function fileExists(filePath) {
  try {
    return nodeFs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
function statMtimeMsOrNull(filePath) {
  try {
    return nodeFs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

// src/editor-bridge.ts
var integrityPollBodies = /* @__PURE__ */ new WeakMap();
var LOG_PREFIX = "[opencode-history-ghost]";
var warnedMessages = /* @__PURE__ */ new Set();
var installedWrapperSymbol = /* @__PURE__ */ Symbol.for("opencode-history-ghost.installed-wrapper");
function unwrapInstalledWrapper(slotValue) {
  if (typeof slotValue !== "function") return slotValue;
  const slotRecord = slotValue;
  if (!Object.prototype.hasOwnProperty.call(slotRecord, installedWrapperSymbol)) return slotValue;
  return slotRecord[installedWrapperSymbol];
}
function warnOnce(message, error) {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`${LOG_PREFIX} ${message}`, error);
}
function focusedEditor(context) {
  try {
    const renderer = context?.renderer;
    const editor = renderer?.currentFocusedEditor;
    if (!editor || editor.isDestroyed === true) return null;
    return editor;
  } catch (error) {
    warnOnce("failed to read the focused editor:", error);
    return null;
  }
}
function createEditorBridge(context, identity) {
  const inputHandlers = /* @__PURE__ */ new Set();
  const caretMoveHandlers = /* @__PURE__ */ new Set();
  const foreignEditorFocusHandlers = /* @__PURE__ */ new Set();
  let wrappedEditor = null;
  let originalOnContentChange;
  let installedContentChangeWrapper;
  let originalOnCursorChange;
  let installedCursorChangeWrapper;
  let identityPollTimer;
  let stopFocusListening;
  let lastUntrustedFocus;
  let disposed = false;
  function snapshot2(editor) {
    const text = editor.plainText;
    const offset = editor.cursorOffset;
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    const buffer = editor.editBuffer;
    if (buffer && typeof buffer.measureText === "function" && typeof buffer.getTextRange === "function") {
      const end = buffer.measureText(text);
      if (offset > end) return null;
      const prefix = buffer.getTextRange(0, offset);
      const suffix = buffer.getTextRange(offset, end);
      if (prefix + suffix !== text || buffer.measureText(prefix) !== offset) return null;
      return { editor, text, prefix, offset };
    }
    if (!buffer && offset === text.length) return { editor, text, prefix: text, offset };
    return null;
  }
  function caretAtTextEnd2(editor) {
    const text = editor.plainText;
    const measureText = editor.editBuffer?.measureText;
    if (typeof measureText === "function") {
      return editor.cursorOffset >= measureText.call(editor.editBuffer, text);
    }
    return editor.cursorOffset >= text.length;
  }
  function notifyInput(editor) {
    if (inputHandlers.size === 0) return;
    let editorText;
    try {
      editorText = editor.plainText;
    } catch (error) {
      warnOnce("failed to read the editor text:", error);
      return;
    }
    for (const inputHandler of inputHandlers) {
      try {
        inputHandler(editorText);
      } catch (error) {
        warnOnce("an input handler failed:", error);
      }
    }
  }
  function notifyCaretMove(editor) {
    if (caretMoveHandlers.size === 0) return;
    let caretAtEnd;
    try {
      caretAtEnd = caretAtTextEnd2(editor);
    } catch (error) {
      warnOnce("failed to read the caret position:", error);
      return;
    }
    for (const caretMoveHandler of caretMoveHandlers) {
      try {
        caretMoveHandler(caretAtEnd);
      } catch (error) {
        warnOnce("a caret-move handler failed:", error);
      }
    }
  }
  function editorHooksStillInstalled(editor) {
    return installedContentChangeWrapper !== void 0 && installedCursorChangeWrapper !== void 0 && editor.onContentChange === installedContentChangeWrapper && editor.onCursorChange === installedCursorChangeWrapper;
  }
  function installEditorHooks(editor) {
    if (wrappedEditor === editor && editorHooksStillInstalled(editor)) return;
    if (wrappedEditor !== editor) {
      detachEditorHooks();
    }
    const capturedEditor = editor;
    if (installedContentChangeWrapper === void 0 || editor.onContentChange !== installedContentChangeWrapper) {
      originalOnContentChange = unwrapInstalledWrapper(editor.onContentChange);
      const capturedHostContentChange = originalOnContentChange;
      installedContentChangeWrapper = (event) => {
        if (capturedHostContentChange) {
          try {
            capturedHostContentChange(event);
          } catch (error) {
            warnOnce("the host onContentChange listener failed:", error);
          }
        }
        if (capturedEditor.isDestroyed === true || wrappedEditor !== capturedEditor || identity.resolve() !== capturedEditor) return;
        notifyInput(capturedEditor);
      };
      installedContentChangeWrapper[installedWrapperSymbol] = capturedHostContentChange;
      try {
        editor.onContentChange = installedContentChangeWrapper;
      } catch (error) {
        warnOnce("failed to hook editor content changes:", error);
        installedContentChangeWrapper = void 0;
        originalOnContentChange = void 0;
      }
    }
    if (installedCursorChangeWrapper === void 0 || editor.onCursorChange !== installedCursorChangeWrapper) {
      originalOnCursorChange = unwrapInstalledWrapper(editor.onCursorChange);
      const capturedHostCursorChange = originalOnCursorChange;
      installedCursorChangeWrapper = (event) => {
        if (capturedHostCursorChange) {
          try {
            capturedHostCursorChange(event);
          } catch (error) {
            warnOnce("the host onCursorChange listener failed:", error);
          }
        }
        if (capturedEditor.isDestroyed === true || wrappedEditor !== capturedEditor || identity.resolve() !== capturedEditor) return;
        notifyCaretMove(capturedEditor);
      };
      installedCursorChangeWrapper[installedWrapperSymbol] = capturedHostCursorChange;
      try {
        editor.onCursorChange = installedCursorChangeWrapper;
      } catch (error) {
        warnOnce("failed to hook editor caret changes:", error);
        installedCursorChangeWrapper = void 0;
        originalOnCursorChange = void 0;
      }
    }
    wrappedEditor = editor;
  }
  function detachEditorHooks() {
    const editor = wrappedEditor;
    if (!editor) return;
    wrappedEditor = null;
    try {
      if (installedContentChangeWrapper !== void 0 && editor.onContentChange === installedContentChangeWrapper) {
        editor.onContentChange = originalOnContentChange;
      }
    } catch (error) {
      warnOnce("failed to restore the original onContentChange listener:", error);
    }
    try {
      if (installedCursorChangeWrapper !== void 0 && editor.onCursorChange === installedCursorChangeWrapper) {
        editor.onCursorChange = originalOnCursorChange;
      }
    } catch (error) {
      warnOnce("failed to restore the original onCursorChange listener:", error);
    }
    originalOnContentChange = void 0;
    installedContentChangeWrapper = void 0;
    originalOnCursorChange = void 0;
    installedCursorChangeWrapper = void 0;
  }
  function notifyUntrustedFocus(foreignEditor) {
    if (foreignEditor === lastUntrustedFocus) return;
    lastUntrustedFocus = foreignEditor;
    if (foreignEditorFocusHandlers.size === 0) return;
    for (const foreignFocusHandler of foreignEditorFocusHandlers) {
      try {
        foreignFocusHandler(foreignEditor);
      } catch (error) {
        warnOnce("a foreign-editor-focus handler failed:", error);
      }
    }
  }
  function trustedFocusedEditor() {
    if (disposed) return null;
    return identity.resolve();
  }
  function runIdentityPoll() {
    try {
      const editor = identity.resolve();
      if (editor) lastUntrustedFocus = void 0;
      else notifyUntrustedFocus(focusedEditor(context));
      if (wrappedEditor && (wrappedEditor.isDestroyed || editor && wrappedEditor !== editor)) detachEditorHooks();
      if (editor && editor === wrappedEditor) {
        if (editorHooksStillInstalled(editor)) return;
        installEditorHooks(editor);
        return;
      }
      if (editor) {
        installEditorHooks(editor);
        notifyInput(editor);
        return;
      }
      if (wrappedEditor?.isDestroyed === true) detachEditorHooks();
    } catch (error) {
      warnOnce("editor identity poll failed:", error);
    }
  }
  const bridge = {
    current() {
      return trustedFocusedEditor();
    },
    inputText() {
      const editor = trustedFocusedEditor();
      if (!editor) return null;
      try {
        return editor.plainText;
      } catch (error) {
        warnOnce("failed to read the editor text:", error);
        return null;
      }
    },
    caretSnapshot() {
      const editor = trustedFocusedEditor();
      if (!editor) return null;
      try {
        return snapshot2(editor);
      } catch (error) {
        warnOnce("failed to read the caret prefix:", error);
        return null;
      }
    },
    caretPrefix() {
      return bridge.caretSnapshot()?.prefix ?? null;
    },
    cursorAtEnd() {
      const editor = trustedFocusedEditor();
      if (!editor) return false;
      try {
        return caretAtTextEnd2(editor);
      } catch (error) {
        warnOnce("failed to read the caret position:", error);
        return false;
      }
    },
    acceptFullText(text) {
      const editor = trustedFocusedEditor();
      if (!editor) return false;
      try {
        editor.replaceText(text);
        return true;
      } catch (error) {
        warnOnce("failed to write the accepted suggestion into the editor:", error);
        return false;
      }
    },
    onInput(inputHandler) {
      inputHandlers.add(inputHandler);
      return () => {
        inputHandlers.delete(inputHandler);
      };
    },
    onCaretMove(caretMoveHandler) {
      caretMoveHandlers.add(caretMoveHandler);
      return () => {
        caretMoveHandlers.delete(caretMoveHandler);
      };
    },
    onForeignEditorFocus(foreignFocusHandler) {
      foreignEditorFocusHandlers.add(foreignFocusHandler);
      return () => {
        foreignEditorFocusHandlers.delete(foreignFocusHandler);
      };
    },
    watch() {
      if (identityPollTimer !== void 0 || disposed) return;
      try {
        const renderer = context?.renderer;
        if (renderer?.on && renderer?.off) {
          const onFocusChange = () => {
            const focused = focusedEditor(context);
            if (identity.resolve() === focused && focused) lastUntrustedFocus = void 0;
            else notifyUntrustedFocus(focused);
          };
          renderer.on("focused_editor", onFocusChange);
          stopFocusListening = () => renderer.off?.("focused_editor", onFocusChange);
        }
      } catch (error) {
        warnOnce("failed to subscribe to editor focus changes:", error);
      }
      identityPollTimer = setInterval(runIdentityPoll, 1500);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopFocusListening?.();
      if (identityPollTimer !== void 0) {
        clearInterval(identityPollTimer);
        identityPollTimer = void 0;
      }
      detachEditorHooks();
      inputHandlers.clear();
      caretMoveHandlers.clear();
      foreignEditorFocusHandlers.clear();
    }
  };
  integrityPollBodies.set(bridge, runIdentityPoll);
  return bridge;
}

// src/composer-identity.ts
import { BoxRenderable, TextareaRenderable } from "@opentui/core";
function directChildren(node) {
  return node.getChildren().filter((child) => child.parent === node && !child.isDestroyed);
}
function connectedToRenderer(node, rendererRoot) {
  const visited = /* @__PURE__ */ new Set();
  let cursor = node;
  while (cursor && !visited.has(cursor)) {
    if (cursor.isDestroyed) return false;
    if (cursor === rendererRoot) return true;
    visited.add(cursor);
    const parent = cursor.parent;
    if (!parent || !directChildren(parent).includes(cursor)) return false;
    cursor = parent;
  }
  return false;
}
function editorUnderMarker(marker, rendererRoot) {
  const markerNode = marker;
  if (!connectedToRenderer(markerNode, rendererRoot)) return null;
  const footer = markerNode.parent;
  const promptRoot = footer?.parent;
  if (!(footer instanceof BoxRenderable) || !(promptRoot instanceof BoxRenderable) || !directChildren(footer).includes(markerNode) || !connectedToRenderer(promptRoot, rendererRoot)) return null;
  const candidates = [];
  for (const border of directChildren(promptRoot)) {
    if (!(border instanceof BoxRenderable) || border === footer) continue;
    for (const padding of directChildren(border)) {
      if (!(padding instanceof BoxRenderable)) continue;
      for (const child of directChildren(padding)) {
        if (child instanceof TextareaRenderable) candidates.push(child);
      }
    }
  }
  return candidates.length === 1 && connectedToRenderer(candidates[0], rendererRoot) ? candidates[0] : null;
}
function createComposerIdentity(context) {
  const markers = /* @__PURE__ */ new Map();
  const host = context;
  return {
    register(sessionID, marker) {
      if (typeof sessionID === "string" && sessionID.length > 0) markers.set(marker, { sessionID, marker });
    },
    unregister(marker) {
      markers.delete(marker);
    },
    resolve() {
      try {
        for (const marker of markers.keys()) {
          if (marker.isDestroyed) markers.delete(marker);
        }
        const route = host.ui?.router?.current();
        const rendererRoot = host.renderer?.root;
        const focus = host.renderer?.currentFocusedEditor;
        if (route?.type !== "session" || !route.sessionID || !rendererRoot || !focus) return null;
        const candidates = [];
        for (const record of markers.values()) {
          if (record.sessionID !== route.sessionID) continue;
          const editor = editorUnderMarker(record.marker, rendererRoot);
          if (editor) candidates.push(editor);
        }
        return candidates.length === 1 && candidates[0] === focus ? candidates[0] : null;
      } catch {
        return null;
      }
    },
    dispose() {
      markers.clear();
    }
  };
}

// node_modules/fuzzysort/fuzzysort.js
function single(search, target) {
  if (!search || !target) return null;
  let query = getQuery(search);
  if (!isPrepared(target)) target = getPrepared(target);
  if ((query.bitflags & target._bitflags) !== query.bitflags) return null;
  let result = !query.hasSpace && query.lowerCodes.length === 2 ? algorithm2(query, target) : algorithm(query, target);
  return result && materialize(result);
}
function go(search, targets, options) {
  if (targets instanceof SnapshotTargets) return goSnapshot(search, targets, options);
  let key = options?.key;
  let keys = !key && options?.keys;
  let firstTarget = targets[0];
  if (!key && !keys && typeof firstTarget === "object" && firstTarget !== null && !isPrepared(firstTarget)) {
    throw new Error("fuzzysort: key or keys is required when searching object targets");
  }
  if (!search) return all(targets, options);
  let query = getQuery(search);
  if (keys) return goKeys(query, targets, options);
  let searchBitflags = query.bitflags;
  let twoChar = !query.hasSpace && query.lowerCodes.length === 2;
  let threshold = denormalizeScore(options?.threshold ?? 0.5);
  let limit = getLimit(options);
  let scoreFn = options?.scoreFn;
  let resultCount = 0;
  let limited = 0;
  let getter = key && makeGetter(key);
  for (let i = 0; i < targets.length; i++) {
    let obj = targets[i];
    let target = key ? getter === null ? obj[key] : getter(obj) : obj;
    if (!target) continue;
    if (!isPrepared(target)) target = getPrepared(target);
    if ((searchBitflags & target._bitflags) !== searchBitflags) continue;
    let result = twoChar ? algorithm2(query, target) : algorithm(query, target);
    if (result === null) continue;
    let resultScore = result._score;
    if (scoreFn) {
      result = materialize(result, key ? obj : void 0);
      resultScore = scoreFn(result);
      if (!resultScore) continue;
      result._score = resultScore = denormalizeScore(resultScore);
    }
    if (resultScore < threshold) continue;
    let room = resultCount < limit;
    if (room) resultCount++;
    else {
      limited++;
      if (resultScore <= heap.peek()._score) continue;
    }
    if (!scoreFn) result = materialize(result, key ? obj : void 0);
    room ? heap.add(result) : heap.replaceTop(result);
  }
  return finishResults(resultCount, limited);
}
function highlight(result, open = "<b>", close = "</b>", threshold = 0.5) {
  let callback = typeof open === "function" ? open : null;
  let target = result.target;
  if (result._bestKeyScore !== void 0 && normalizeScore(result._score) < normalizeScore(result._bestKeyScore) * threshold) return callback ? [target] : target;
  let raw = result._indexes;
  let indexes = raw === void 0 ? result.indexes : raw.slice(0, raw.len ?? raw.length).sort((a, b) => a - b);
  if (!indexes.length) return callback ? [target] : target;
  let output = callback ? [] : "";
  let lastIndex = 0;
  let matchI = 0;
  for (let i = 0; i < indexes.length; ) {
    let start = indexes[i++];
    let end = start + 1;
    while (indexes[i] === end) {
      i++;
      end++;
    }
    let before = target.slice(lastIndex, start);
    let match = target.slice(start, end);
    if (callback) output.push(before, callback(match, matchI++));
    else output += before + open + match + close;
    lastIndex = end;
  }
  if (callback) output.push(target.slice(lastIndex));
  else output += target.slice(lastIndex);
  return output;
}
function score(result) {
  let value = result.score;
  return value === void 0 ? normalizeScore(result._score) : value;
}
function remap(mappings) {
  for (let char in mappings) {
    remappings[char] = mappings[char];
    if (char.charCodeAt(0) < 128) customAsciiRemappings = true;
  }
  cleanup();
}
function prepare(target) {
  return prepTarget(target);
}
function snapshot(targets, options) {
  return new SnapshotTargets(targets, options);
}
function cleanup() {
  targetCache.clear();
  searchCache.clear();
  heap.clear();
  simpleMatch = [];
  strictMatch = [];
  seen = [];
  seenAt = [];
  changes = [];
  partials = [];
  spaceScores = [];
  partIndexes = [];
  winnerIndexes = [];
  winnerScores = [];
  winnerKeys = [];
  keyTargets = [];
  keyResults = [];
  candidateBitOffsets = [];
  seenGeneration = 0;
}
function goSnapshotValues(search, snapshot2, options, singleChar) {
  let targets = snapshot2._targets;
  let objects = snapshot2._objects;
  let threshold = denormalizeScore(options?.threshold ?? 0.5);
  let limit = getLimit(options);
  let scoreFn = options?.scoreFn;
  let searchLen = search.lowerCodes.length;
  let shortSearch = !search.hasSpace && searchLen <= 3;
  let twoChar = !search.hasSpace && searchLen === 2;
  let rows = snapshot2._candidateRows;
  let rowsLength = snapshot2._candidateLength;
  let matchedRows = snapshot2._rows;
  let matchedCount = 0;
  let resultCount = 0;
  let limited = 0;
  for (let n = 0; n < rowsLength; n++) {
    let i = rows === null ? n : rows[n];
    let target = targets[i];
    if (target === noTarget || (search.bitflags & target._bitflags) !== search.bitflags) continue;
    let targetShort = shortSearch && target.target.length < 65535;
    let cutoff = !scoreFn && threshold === -INF && resultCount >= limit ? heap.peek()._score : -INF;
    let result;
    if (singleChar && targetShort) result = algorithm1(search, target, snapshot2._first, i);
    else if (twoChar && targetShort) {
      let start = snapshot2._offsets[i];
      let end = snapshot2._offsets[i + 1];
      result = algorithm2(search, target, snapshot2._beginnings, start, end, cutoff);
    } else if (twoChar) result = algorithm2(search, target, null, 0, 0, cutoff);
    else if (targetShort) {
      let start = snapshot2._offsets[i];
      let end = snapshot2._offsets[i + 1];
      result = algorithm(search, target, false, false, false, true, snapshot2._beginnings, start, end, cutoff);
    } else result = algorithm(search, target, false, false, false, true, null, 0, 0, cutoff);
    if (result === null) continue;
    matchedRows[matchedCount++] = i;
    if (result === prunedMatch) {
      limited++;
      continue;
    }
    let resultScore = result._score;
    if (scoreFn) {
      result = materialize(result, objects?.[i]);
      resultScore = scoreFn(result);
      if (!resultScore) continue;
      result._score = resultScore = denormalizeScore(resultScore);
    }
    if (resultScore < threshold) continue;
    let room = resultCount < limit;
    if (room) resultCount++;
    else {
      limited++;
      if (resultScore <= heap.peek()._score) continue;
    }
    if (objects && !scoreFn) result = materialize(result, objects[i]);
    room ? heap.add(result) : heap.replaceTop(result);
  }
  snapshot2._matchedRowsLen = matchedCount;
  return finishResults(resultCount, limited, !objects && !scoreFn && materialize);
}
function goSnapshot(search, snapshot2, options) {
  if (options?.key || options?.keys) throw new Error("fuzzysort: key/keys must be provided to snapshot(), not go()");
  snapshot2._finish();
  if (!search) return allSnapshot(snapshot2, options);
  let query = getQuery(search);
  let backtrack = snapshot2._backtrack(query, options);
  if (backtrack) return backtrack;
  snapshot2._beginSearch(query);
  try {
    let results;
    if (snapshot2._mode < 2) {
      let searchLen = query.lowerCodes.length;
      let code = query.lowerCodes[0];
      let singleChar = searchLen === 1 && code >= 97 && code <= 122;
      results = goSnapshotValues(query, snapshot2, options, singleChar);
    } else results = goKeys(query, snapshot2._objects, options, snapshot2);
    snapshot2._endSearch(query);
    snapshot2._remember(query, results, options);
    return results;
  } catch (error) {
    snapshot2._resetSearch();
    throw error;
  }
}
function goKeys(query, objects, options, snapshot2) {
  let indexed = snapshot2 !== void 0;
  let keys = indexed ? null : options.keys;
  let getters = indexed ? null : keys.map(makeGetter);
  let targets = indexed ? snapshot2._targets : null;
  let keysLength = indexed ? snapshot2._keysLength : keys.length;
  let searchBitflags = query.bitflags;
  let hasSpace = query.hasSpace;
  let spaceCount = query.parts.length;
  let threshold = denormalizeScore(options?.threshold ?? 0.5);
  let limit = getLimit(options);
  let searchLen = query.lowerCodes.length;
  let short = indexed && !hasSpace && searchLen <= 3;
  let twoChar = !hasSpace && searchLen === 2;
  let code = query.lowerCodes[0];
  let singleChar = short && searchLen === 1 && code >= 97 && code <= 122;
  let scoreFn = options?.scoreFn;
  let deferMaterialization = indexed && !scoreFn && (limit !== INF || threshold > -INF);
  let rows = indexed ? snapshot2._candidateRows : null;
  let rowsLength = indexed ? snapshot2._candidateLength : objects.length;
  let matchedRows = indexed ? snapshot2._rows : null;
  let matchedCount = 0;
  let resultCount = 0;
  let limited = 0;
  outer: for (let n = 0; n < rowsLength; n++) {
    let i = rows === null ? n : rows[n];
    let row = i * keysLength;
    if (indexed) {
      if ((searchBitflags & snapshot2._bitflags[i]) !== searchBitflags) continue;
    } else {
      let obj = objects[i];
      let keysBitflags = 0;
      for (let k = 0; k < keysLength; k++) {
        let target = getters[k] === null ? obj[keys[k]] : getters[k](obj);
        if (!target) target = noTarget;
        else if (!isPrepared(target)) target = getPrepared(target);
        keyTargets[k] = target;
        keysBitflags |= target._bitflags;
      }
      if ((searchBitflags & keysBitflags) !== searchBitflags) continue;
    }
    if (hasSpace) for (let s = 0; s < spaceCount; s++) {
      spaceScores[s] = winnerScores[s] = -INF;
      winnerKeys[s] = -1;
    }
    for (let k = 0; k < keysLength; k++) {
      let target = indexed ? targets[row + k] : keyTargets[k];
      if (target === noTarget) {
        keyResults[k] = noTarget;
        continue;
      }
      if (hasSpace && indexed) {
        let possible = false;
        for (let s = 0; s < spaceCount; s++) {
          let partBitflags = query.parts[s].bitflags;
          if ((partBitflags & target._bitflags) === partBitflags) {
            possible = true;
            break;
          }
        }
        if (!possible) {
          keyResults[k] = noTarget;
          continue;
        }
      } else if (!hasSpace && (searchBitflags & target._bitflags) !== searchBitflags) {
        keyResults[k] = noTarget;
        continue;
      }
      let match;
      if (indexed) {
        let valueRow = row + k;
        let targetShort = short && target.target.length < 65535;
        if (singleChar && targetShort) match = algorithm1(query, target, snapshot2._first, valueRow);
        else if (twoChar && targetShort) {
          let start = snapshot2._offsets[valueRow];
          let end = snapshot2._offsets[valueRow + 1];
          match = algorithm2(query, target, snapshot2._beginnings, start, end);
        } else if (twoChar) match = algorithm2(query, target);
        else if (targetShort) {
          let start = snapshot2._offsets[valueRow];
          let end = snapshot2._offsets[valueRow + 1];
          match = algorithm(query, target, false, false, false, true, snapshot2._beginnings, start, end);
        } else match = algorithm(query, target, false, hasSpace);
      } else match = twoChar ? algorithm2(query, target) : algorithm(query, target, false, hasSpace);
      if (match === null) {
        keyResults[k] = noTarget;
        continue;
      }
      keyResults[k] = deferMaterialization ? match : materialize(match);
      if (hasSpace) {
        mergePartScores(spaceCount);
        for (let s = 0; s < spaceCount; s++) {
          let partScore = partials[s];
          if (partScore <= winnerScores[s]) continue;
          winnerScores[s] = partScore;
          winnerKeys[s] = k;
          let source = partIndexes[s];
          let winner = winnerIndexes[s] ||= [];
          winner.length = source.length;
          for (let j = 0; j < source.length; j++) winner[j] = source[j];
        }
      }
    }
    if (hasSpace) {
      for (let s = 0; s < spaceCount; s++) if (winnerKeys[s] !== -1) {
        appendIndexes(keyResults[winnerKeys[s]]._indexes, winnerIndexes[s]);
      }
    }
    let resultScore;
    if (hasSpace) {
      resultScore = 0;
      for (let s = 0; s < spaceCount; s++) {
        let partScore = spaceScores[s];
        if (partScore === -INF) continue outer;
        resultScore += partScore;
      }
    } else {
      resultScore = mergeScores(keyResults, keysLength);
      if (resultScore === -INF) continue;
    }
    if (indexed) matchedRows[matchedCount++] = i;
    let result = deferMaterialization ? null : captureKeysResult(keyResults, keysLength, objects[i], resultScore, hasSpace);
    if (scoreFn) {
      resultScore = scoreFn(result);
      if (!resultScore) continue;
      result._score = resultScore = denormalizeScore(resultScore);
    }
    if (resultScore < threshold) continue;
    let room = resultCount < limit;
    if (room) resultCount++;
    else {
      limited++;
      if (resultScore <= heap.peek()._score) continue;
    }
    if (result === null) result = captureKeysResult(keyResults, keysLength, objects[i], resultScore, hasSpace);
    room ? heap.add(result) : heap.replaceTop(result);
  }
  if (indexed) snapshot2._matchedRowsLen = matchedCount;
  return finishResults(resultCount, limited, deferMaterialization && materializeKeys);
}
function allSnapshot(snapshot2, options) {
  let results = [];
  let targets = snapshot2._targets;
  let objects = snapshot2._objects;
  let keysLength = snapshot2._keysLength;
  let total = keysLength === void 0 ? targets.length : objects.length;
  results.total = total;
  let limit = getLimit(options);
  for (let i = 0, length = Math.min(total, limit); i < length; i++) {
    if (keysLength === void 0) {
      results.push(newResult(targets[i].target, -INF, objects?.[i]));
      continue;
    }
    let row = i * keysLength;
    for (let k = 0; k < keysLength; k++) {
      let target = targets[row + k];
      keyResults[k] = target === noTarget ? noTarget : newResult(target.target, -INF);
    }
    results.push(captureKeysResult(keyResults, keysLength, objects[i], -INF));
  }
  return results;
}
function all(targets, options) {
  let results = [];
  results.total = targets.length;
  let limit = getLimit(options);
  let key = options?.key;
  let keys = !key && options?.keys;
  if (keys) {
    let getters = keys.map(makeGetter);
    for (let obj of targets) {
      for (let k = keys.length - 1; k >= 0; k--) {
        let target = getters[k] === null ? obj[keys[k]] : getters[k](obj);
        if (!target) keyResults[k] = noTarget;
        else {
          if (!isPrepared(target)) target = getPrepared(target);
          target._score = -INF;
          target._indexes.len = 0;
          keyResults[k] = target;
        }
      }
      results.push(captureKeysResult(keyResults, keys.length, obj, -INF));
      if (results.length >= limit) break;
    }
    return results;
  }
  let getter = key && makeGetter(key);
  for (let obj of targets) {
    let target = key ? getter === null ? obj[key] : getter(obj) : obj;
    if (target == null) continue;
    if (!isPrepared(target)) target = getPrepared(target);
    if (key) target = newResult(target.target, -INF, obj);
    else {
      target._score = -INF;
      target._indexes.len = 0;
    }
    results.push(target);
    if (results.length >= limit) break;
  }
  return results;
}
function finishResults(length, limited, transform) {
  if (!length) return noResults;
  let results = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    let result = heap.poll();
    if (transform) result = transform(result);
    if (result instanceof KeysResult && !result._partWinners) markBestKeyScore(result);
    results[i] = result;
  }
  results.total = length + limited;
  return results;
}
function materializeKeys(result) {
  for (let k = 0; k < result.length; k++) if (result[k] !== noTarget) result[k] = materialize(result[k]);
  return result;
}
function algorithm1(search, target, firstTable, row) {
  let matchI = target._targetLower.indexOf(search._lower);
  if (matchI === -1) return null;
  let beginning = firstTable[row * 26 + search.lowerCodes[0] - 97];
  let strict = beginning !== 0;
  if (strict) matchI = beginning - 1;
  let score2 = matchI === 0 ? 0 : -matchI * matchI * 0.2;
  if (!strict) score2 *= 1e3;
  else if (target._beginningsLen > 24) score2 *= (target._beginningsLen - 24) * 10;
  target._score = score2 - target._targetLowerCodes.length + 1;
  target._indexes[0] = matchI;
  target._indexes.len = 1;
  return target;
}
function algorithm2(search, target, beginnings = null, start = 0, end = 0, cutoff = -INF) {
  let targetCodes = target._targetLowerCodes;
  let targetLen = targetCodes.length;
  let firstCode = search.lowerCodes[0];
  let secondCode = search.lowerCodes[1];
  let first = 0;
  while (targetCodes[first] !== firstCode) if (++first >= targetLen) return null;
  let second = first + 1;
  while (targetCodes[second] !== secondCode) if (++second >= targetLen) return null;
  if (cutoff !== -INF && scoreCeiling(2, targetLen) <= cutoff) return prunedMatch;
  if (beginnings === null) {
    beginnings = target._beginnings;
    if (beginnings === null) target._beginnings = beginnings = makeBeginnings(target);
    end = beginnings.length;
  }
  let substringI = target._targetLower.indexOf(search._lower, first);
  let substring = substringI !== -1;
  let low = lowerBound(beginnings, start, end, substringI);
  let substringStart = substring && low < end && beginnings[low] === substringI;
  let strict = substringStart && substringI === first;
  if (!strict) {
    let firstBeginning = start;
    while (firstBeginning < end && beginnings[firstBeginning] < first) firstBeginning++;
    for (let backtracks = 0; firstBeginning < end; ) {
      let strictFirst = beginnings[firstBeginning];
      if (targetCodes[strictFirst] !== firstCode) {
        firstBeginning++;
        continue;
      }
      let consecutive = strictFirst + 1;
      if (targetCodes[consecutive] === secondCode) {
        first = strictFirst;
        second = consecutive;
        strict = true;
        break;
      }
      let secondBeginning = firstBeginning + 1;
      while (secondBeginning < end && beginnings[secondBeginning] <= consecutive) secondBeginning++;
      while (secondBeginning < end && targetCodes[beginnings[secondBeginning]] !== secondCode) secondBeginning++;
      if (secondBeginning < end) {
        first = strictFirst;
        second = beginnings[secondBeginning];
        strict = true;
        break;
      }
      if (++backtracks > 200) break;
      firstBeginning++;
    }
  }
  if (substring && !substringStart) {
    while (low < end && beginnings[low] <= substringI) low++;
    for (; low < end; low++) {
      let index = beginnings[low];
      if (targetCodes[index] === firstCode && targetCodes[index + 1] === secondCode) {
        substringI = index;
        substringStart = true;
        break;
      }
    }
  }
  if (substring && (!strict || substringStart)) {
    first = substringI;
    second = substringI + 1;
  }
  let resultScore = second - first === 1 ? 0 : first - second * 2 - 11;
  if (first) resultScore -= first * first * 0.2;
  if (!strict) resultScore *= 1e3;
  else if (end - start > 24) resultScore *= (end - start - 24) * 10;
  let lengthPenalty = (targetLen - 2) / 2;
  resultScore -= lengthPenalty;
  if (substring) resultScore /= 5;
  if (substringStart) resultScore /= 5;
  resultScore -= lengthPenalty;
  let substringEnd = substring && second === first + 1 && (second + 1 === targetLen || isBeginning(beginnings, start, end, second + 1));
  target._score = substringEnd ? resultScore + Math.min(4, -resultScore / 2) : resultScore;
  target._indexes[0] = first;
  target._indexes[1] = second;
  target._indexes.len = 2;
  return target;
}
function algorithm(search, target, spaces = false, partial = false, changed = false, singleMatch = true, beginnings = null, start = 0, end = 0, cutoff = -INF) {
  if (!spaces && search.hasSpace) return algorithmSpaces(search, target, partial);
  let searchCodes = search.lowerCodes;
  let targetCodes = target._targetLowerCodes;
  let searchLen = searchCodes.length;
  let targetLen = targetCodes.length;
  let searchCode = searchCodes[0];
  let searchI = 0;
  let targetI = 0;
  for (; ; ) {
    if (searchCode === targetCodes[targetI]) {
      simpleMatch[searchI] = targetI;
      if (++searchI === searchLen) break;
      searchCode = searchCodes[searchI];
    }
    if (++targetI >= targetLen) return null;
  }
  if (cutoff !== -INF && searchLen > 1 && scoreCeiling(searchLen, targetLen) <= cutoff) return prunedMatch;
  if (searchLen === 1 && !changed && singleMatch) {
    let matchI;
    let strict2;
    if (target._singleMatchCode === searchCode) {
      matchI = target._singleMatchIndex;
      strict2 = target._singleMatchStrict;
    } else if (target._nextBeginningIndexes !== null) {
      let next2 = target._nextBeginningIndexes;
      targetI = simpleMatch[0] === 0 ? 0 : next2[simpleMatch[0] - 1];
      while (targetI < targetLen && searchCode !== targetCodes[targetI]) targetI = next2[targetI];
      strict2 = targetI < targetLen;
      matchI = strict2 ? targetI : simpleMatch[0];
    } else {
      prepareSingleMatch(target, searchCode, simpleMatch[0]);
      matchI = target._singleMatchIndex;
      strict2 = target._singleMatchStrict;
    }
    let resultScore = matchI === 0 ? 0 : -matchI * matchI * 0.2;
    if (!strict2) resultScore *= 1e3;
    else if (target._beginningsLen > 24) resultScore *= (target._beginningsLen - 24) * 10;
    target._score = resultScore - (targetLen - 1);
    target._indexes[0] = matchI;
    target._indexes.len = 1;
    return target;
  }
  searchI = 0;
  let strict = false;
  let strictLen = 0;
  let next = target._nextBeginningIndexes;
  if (beginnings === null && next === null) next = target._nextBeginningIndexes = makeNextBeginnings(target);
  let beginningLen = beginnings === null ? changed ? 0 : target._beginningsLen : end - start;
  if (!beginningLen) {
    beginningLen = 1;
    for (let i = next[0]; i < targetLen; i = next[i]) beginningLen++;
    if (!changed) target._beginningsLen = beginningLen;
  }
  let substringI = searchLen <= 1 ? -1 : target._targetLower.indexOf(search._lower, simpleMatch[0]);
  let isSubstring = substringI !== -1;
  let substringStart = isSubstring && (substringI === 0 || (beginnings ? isBeginning(beginnings, start, end, substringI) : next[substringI - 1] === substringI));
  if (substringStart && substringI === simpleMatch[0]) strict = true;
  else {
    targetI = simpleMatch[0] === 0 ? 0 : beginnings ? nextBeginning(beginnings, start, end, simpleMatch[0] - 1, targetLen) : next[simpleMatch[0] - 1];
    let backtracks = 0;
    if (targetI !== targetLen) for (; ; ) {
      if (targetI >= targetLen) {
        if (searchI <= 0 || ++backtracks > 200) break;
        searchI--;
        let previous = strictMatch[--strictLen];
        targetI = beginnings ? nextBeginning(beginnings, start, end, previous, targetLen) : next[previous];
      } else if (searchCodes[searchI] === targetCodes[targetI]) {
        strictMatch[strictLen++] = targetI;
        if (++searchI === searchLen) {
          strict = true;
          break;
        }
        targetI++;
      } else targetI = beginnings ? nextBeginning(beginnings, start, end, targetI, targetLen) : next[targetI];
    }
  }
  if (isSubstring && !substringStart) {
    if (beginnings) {
      for (let b = start; b < end; b++) {
        let i = beginnings[b];
        if (i <= substringI) continue;
        let s = 0;
        for (; s < searchLen && searchCodes[s] === targetCodes[i + s]; s++) ;
        if (s === searchLen) {
          substringI = i;
          substringStart = true;
          break;
        }
      }
    } else for (let i = 0; i < next.length; i = next[i]) {
      if (i <= substringI) continue;
      let s = 0;
      for (; s < searchLen && searchCodes[s] === targetCodes[i + s]; s++) ;
      if (s === searchLen) {
        substringI = i;
        substringStart = true;
        break;
      }
    }
  }
  let matches;
  if (!strict) {
    if (isSubstring) for (let i = 0; i < searchLen; i++) simpleMatch[i] = substringI + i;
    matches = simpleMatch;
  } else if (substringStart) {
    for (let i = 0; i < searchLen; i++) simpleMatch[i] = substringI + i;
    matches = simpleMatch;
  } else matches = strictMatch;
  let matchEnd = matches[searchLen - 1] + 1;
  let substringEnd = isSubstring && matchEnd - matches[0] === searchLen && (matchEnd === targetLen || (beginnings ? isBeginning(beginnings, start, end, matchEnd) : next[matchEnd - 1] === matchEnd));
  target._score = calculateScore(matches, searchLen, targetLen, strict, beginningLen, isSubstring, substringStart, substringEnd);
  for (let i = 0; i < searchLen; i++) target._indexes[i] = matches[i];
  target._indexes.len = searchLen;
  return target;
}
function mergePartScores(length) {
  for (let i = 0; i < length; i++) {
    let partial = partials[i];
    let best = spaceScores[i];
    if (partial > -1e3 && best > -INF) best = Math.max(best, (best + partial) / 4);
    spaceScores[i] = Math.max(best, partial);
  }
}
function appendIndexes(indexes, additions) {
  let length = indexes.len;
  outer: for (let i = 0; i < additions.length; i++) {
    let index = additions[i];
    for (let j = 0; j < length; j++) if (indexes[j] === index) continue outer;
    indexes[length++] = index;
  }
  indexes.len = length;
}
function mergeScores(results, length) {
  let total = -INF;
  for (let i = 0; i < length; i++) {
    let score2 = results[i]._score;
    if (score2 > -1e3 && total > -INF) total = Math.max(total, (total + score2) / 4);
    if (score2 > total) total = score2;
  }
  return total;
}
function calculateScore(matches, searchLen, targetLen, strict, beginningLen, substring, substringStart, substringEnd) {
  let score2 = 0;
  let groups = 0;
  for (let i = 1; i < searchLen; i++) if (matches[i] - matches[i - 1] !== 1) {
    score2 -= matches[i];
    groups++;
  }
  let unmatchedDistance = matches[searchLen - 1] - matches[0] - (searchLen - 1);
  score2 -= (12 + unmatchedDistance) * groups;
  if (matches[0] !== 0) score2 -= matches[0] * matches[0] * 0.2;
  if (!strict) score2 *= 1e3;
  else if (beginningLen > 24) score2 *= (beginningLen - 24) * 10;
  let lengthPenalty = (targetLen - searchLen) / 2;
  score2 -= lengthPenalty;
  let substringBonus = 1 + searchLen * searchLen;
  if (substring) score2 /= substringBonus;
  if (substringStart) score2 /= substringBonus;
  score2 -= lengthPenalty;
  return substringEnd ? score2 + Math.min(4, -score2 / 2) : score2;
}
function algorithmSpaces(search, target, partial) {
  let seenLen = 0;
  let generation = ++seenGeneration;
  let score2 = 0;
  let result = null;
  let previousFirst = 0;
  let searches = search.parts;
  let changesLen = 0;
  let matched = false;
  for (let i = 0; i < searches.length; i++) {
    partials[i] = -INF;
    if (partial) (partIndexes[i] ||= []).length = 0;
    result = algorithm(searches[i], target, false, false, changesLen !== 0, false);
    if (result === null) {
      if (partial) continue;
      resetBeginnings(target, changesLen);
      return null;
    }
    matched = true;
    if (i < searches.length - 1) {
      let indexes = result._indexes;
      let consecutive = true;
      for (let j = 0; j < indexes.len - 1; j++) if (indexes[j + 1] - indexes[j] !== 1) {
        consecutive = false;
        break;
      }
      if (consecutive) {
        let beginning = indexes[indexes.len - 1] + 1;
        let previous = target._nextBeginningIndexes[beginning - 1];
        for (let j = beginning - 1; j >= 0 && target._nextBeginningIndexes[j] === previous; j--) {
          target._nextBeginningIndexes[j] = beginning;
          changes[changesLen * 2] = j;
          changes[changesLen * 2 + 1] = previous;
          changesLen++;
        }
      }
    }
    if (partial) {
      let indexes = partIndexes[i];
      indexes.length = result._indexes.len;
      for (let j = 0; j < indexes.length; j++) indexes[j] = result._indexes[j];
    }
    let partScore = result._score / searches.length;
    score2 += partScore;
    partials[i] = partScore;
    if (result._indexes[0] < previousFirst) score2 -= (previousFirst - result._indexes[0]) * 2;
    previousFirst = result._indexes[0];
    if (!partial) for (let j = 0; j < result._indexes.len; j++) {
      let index = result._indexes[j];
      if (seenAt[index] === generation) continue;
      seenAt[index] = generation;
      seen[seenLen++] = index;
    }
  }
  if (partial && !matched) return null;
  resetBeginnings(target, changesLen);
  if (target._bitflags & SPACE_BIT) {
    let spacedResult = algorithm(search, target, true);
    if (spacedResult !== null && spacedResult._score > score2) {
      if (partial) {
        let searchFrom = 0;
        for (let i = 0; i < searches.length; i++) {
          partials[i] = spacedResult._score / searches.length;
          let part = searches[i]._lower;
          let searchI = search._lower.indexOf(part, searchFrom);
          let indexes = partIndexes[i];
          indexes.length = part.length;
          for (let j = 0; j < part.length; j++) indexes[j] = spacedResult._indexes[searchI + j];
          searchFrom = searchI + part.length;
        }
        if (spacedResult._score < GOOD_PART_SCORE) spacedResult._indexes.len = 0;
      }
      return spacedResult;
    }
  }
  if (partial) {
    result = target;
    let targetLower = target._targetLower;
    for (let i = 1; i < searches.length; i++) {
      let previous = partIndexes[i - 1];
      if (!previous.length || !partIndexes[i].length) continue;
      let previousEnd = previous[previous.length - 1] + 1;
      let at = previousEnd;
      let code;
      while ((code = targetLower.charCodeAt(at)) === 32 || code >= 9 && code <= 13) at++;
      let part = searches[i]._lower;
      if (!targetLower.startsWith(part, at)) continue;
      for (let j = previousEnd; j < at; j++) previous.push(j);
      let indexes = partIndexes[i];
      indexes.length = part.length;
      for (let j = 0; j < part.length; j++) indexes[j] = at + j;
    }
    result._indexes.len = 0;
    for (let i = 0; i < searches.length; i++) if (partials[i] * searches.length >= GOOD_PART_SCORE) {
      appendIndexes(result._indexes, partIndexes[i]);
    }
  } else {
    for (let i = 0; i < seenLen; i++) result._indexes[i] = seen[i];
    result._indexes.len = seenLen;
  }
  result._score = score2;
  return result;
}
function resetBeginnings(target, changesLen) {
  for (let i = changesLen - 1; i >= 0; i--) {
    target._nextBeginningIndexes[changes[i * 2]] = changes[i * 2 + 1];
  }
}
var SnapshotTargets = class {
  constructor(targets, options) {
    this._mode = options?.keys ? 2 : options?.key ? 1 : 0;
    this._keys = this._mode === 2 ? options.keys.slice() : [options?.key];
    this._input = targets.slice();
    this._index = 0;
    this._done = false;
    this._error = null;
    this._scheduled = null;
    if (targets.length === 0) this._finish();
    else this._schedule();
  }
  _schedule() {
    if (this._scheduled !== null) return;
    this._scheduled = scheduleTask((deadline) => {
      this._scheduled = null;
      this._run(deadline);
    });
  }
  _cancel() {
    if (this._scheduled !== null) this._scheduled();
    this._scheduled = null;
  }
  _initialize() {
    if (this._targets) return;
    let keysLength = this._mode === 2 ? this._keys.length : 1;
    let valueCount = this._input.length * keysLength;
    let rowCount = this._input.length;
    this._targets = new Array(valueCount);
    this._first = new Uint16Array(valueCount * 26);
    this._offsets = new Uint32Array(valueCount + 1);
    this._buildingBeginnings = [];
    this._rowCount = rowCount;
    this._rowWords = rowCount + 31 >> 5;
    this._rowBits = new Uint32Array(this._rowWords * 32);
    this._rows = new Uint32Array(rowCount);
    this._lastRowsLen = 0;
    this._matchedRowsLen = 0;
    this._lastQuery = null;
    this._candidateRows = null;
    this._candidateLength = rowCount;
    this._history = [];
    if (this._mode) {
      this._objects = this._input;
      this._getters = this._keys.map(makeGetter);
    }
    if (this._mode === 2) {
      this._keysLength = keysLength;
      this._bitflags = new Int32Array(rowCount);
    }
  }
  _run(deadline) {
    if (this._done || this._error) return;
    let end = Date.now() + 4;
    let hasTime = () => deadline && !deadline.didTimeout ? deadline.timeRemaining() > 1 : Date.now() < end;
    try {
      this._initialize();
      do
        this._prepareOne();
      while (this._index < this._input.length && hasTime());
      if (this._index === this._input.length) this._complete();
      else this._schedule();
    } catch (error) {
      this._error = error;
      this._done = true;
    }
  }
  _indexRow(row, bitflags) {
    let flags = bitflags >>> 0;
    let word = row >> 5;
    let mask = 1 << (row & 31);
    let words = this._rowWords;
    let bits = this._rowBits;
    while (flags) {
      let lowest = flags & -flags;
      let bit = 31 - Math.clz32(lowest);
      bits[bit * words + word] |= mask;
      flags = (flags & flags - 1) >>> 0;
    }
  }
  _prepareOne() {
    let i = this._index++;
    let mode = this._mode;
    let obj = this._input[i];
    let keysLength = mode === 2 ? this._keysLength : 1;
    let bitflags = 0;
    for (let k = 0; k < keysLength; k++) {
      let value = mode === 0 ? obj : this._getters[k] === null ? obj[this._keys[k]] : this._getters[k](obj);
      let row = mode === 2 ? i * keysLength + k : i;
      let prepared = this._targets[row] = value ? prepTarget(value) : noTarget;
      if (prepared !== noTarget) indexBeginnings(prepared, this._first, row, this._buildingBeginnings);
      this._offsets[row + 1] = this._buildingBeginnings.length;
      bitflags |= prepared._bitflags;
    }
    if (mode === 2) this._bitflags[i] = bitflags;
    this._indexRow(i, bitflags);
  }
  _complete() {
    this._beginnings = Uint16Array.from(this._buildingBeginnings);
    this._buildingBeginnings = this._input = this._getters = this._keys = null;
    this._done = true;
  }
  _bitOffsets(bitflags) {
    let offsetsLen = 0;
    let words = this._rowWords;
    for (let bit = 0; bit < 32; bit++) if (bitflags & 1 << bit) candidateBitOffsets[offsetsLen++] = bit * words;
    return offsetsLen;
  }
  _matchRows(bitflags, fill = false, stop = INF) {
    let offsetsLen = this._bitOffsets(bitflags);
    if (!offsetsLen) {
      if (fill) {
        this._candidateRows = null;
        this._candidateLength = this._rowCount;
      }
      return this._rowCount;
    }
    let bits = this._rowBits;
    let words = this._rowWords;
    let rowsLen = 0;
    for (let word = 0; word < words; word++) {
      let matches = bits[candidateBitOffsets[0] + word];
      for (let i = 1; i < offsetsLen && matches; i++) matches &= bits[candidateBitOffsets[i] + word];
      if (!fill) {
        rowsLen += bitCount(matches);
        if (rowsLen >= stop) return rowsLen;
        continue;
      }
      while (matches) {
        let lowest = matches & -matches;
        this._rows[rowsLen++] = (word << 5) + 31 - Math.clz32(lowest);
        matches = (matches & matches - 1) >>> 0;
      }
    }
    if (fill) {
      this._candidateRows = this._rows;
      this._candidateLength = rowsLen;
    }
    return rowsLen;
  }
  _beginSearch(query) {
    this._matchedRowsLen = 0;
    let previousQuery = this._lastQuery;
    let previousLength = this._lastRowsLen;
    this._lastQuery = null;
    let bitflags = query.bitflags >>> 0;
    if (previousQuery !== null && query._lower.startsWith(previousQuery)) {
      let staticCount = this._matchRows(bitflags, false, previousLength);
      if (previousLength <= staticCount) {
        this._candidateRows = this._rows;
        this._candidateLength = previousLength;
        return;
      }
    }
    this._matchRows(bitflags, true);
  }
  _endSearch(query) {
    this._lastRowsLen = this._matchedRowsLen;
    this._matchedRowsLen = 0;
    this._lastQuery = query._lower || null;
    this._candidateRows = null;
    this._candidateLength = 0;
  }
  _backtrack(query, options) {
    let history = this._history;
    if (history.length < 2 || options?.scoreFn || options?.threshold !== void 0) return null;
    let limit = getLimit(options);
    if (limit === INF) return null;
    let current = history[history.length - 1];
    let value = query._lower;
    if (current.query === value && current.limit === limit && current.results) return copyResults(current.results);
    if (value.length >= current.query.length || !current.query.startsWith(value)) return null;
    let i = history.length - 2;
    while (i >= 0 && history[i].query.length > value.length) i--;
    let entry = history[i];
    if (!entry || entry.query !== value || entry.limit !== limit) return null;
    history.length = i + 1;
    if (!entry.results) return null;
    this._resetSearch();
    return copyResults(entry.results);
  }
  _remember(query, results, options) {
    let history = this._history;
    let limit = getLimit(options);
    if (options?.scoreFn || options?.threshold !== void 0 || limit === INF || results.length > 256) {
      history.length = 0;
      return;
    }
    let value = query._lower;
    let last = history[history.length - 1];
    if (last && !value.startsWith(last.query)) history.length = 0;
    else if (last?.query === value && last.limit === limit) history.pop();
    history.push({ query: value, limit, results: value.length <= 32 ? copyResults(results) : null });
  }
  _resetSearch() {
    this._lastQuery = null;
    this._lastRowsLen = this._matchedRowsLen = this._candidateLength = 0;
    this._candidateRows = null;
  }
  _finish() {
    if (this._error) throw this._error;
    if (this._done) return;
    this._cancel();
    try {
      this._initialize();
      while (this._index < this._input.length) this._prepareOne();
      this._complete();
    } catch (error) {
      this._error = error;
      this._done = true;
      throw error;
    }
  }
};
function copyResult(result) {
  if (result === noTarget) return noTarget;
  if (result instanceof KeysResult) {
    let copy2 = result.map(copyResult);
    copy2.obj = result.obj;
    copy2._score = result._score;
    if (result._partWinners) copy2._partWinners = true;
    return copy2;
  }
  let copy = materialize(result, result.obj);
  if (result._bestKeyScore !== void 0) copy._bestKeyScore = result._bestKeyScore;
  let indexes = result._indexes;
  copy._indexes = indexes.slice(0, indexes.len ?? indexes.length);
  copy._indexes.len = copy._indexes.length;
  return copy;
}
function copyResults(results) {
  let copies = results.map(copyResult);
  copies.total = results.total;
  return copies;
}
function prepTarget(target) {
  if (isPrepared(target)) target = target.target;
  else if (typeof target === "number") target = "" + target;
  else if (typeof target !== "string") target = "";
  let info = lowerInfo(target);
  return newResult(target, -INF, null, info._lower, info.lowerCodes, info.bitflags);
}
function prepQuery(search) {
  if (typeof search === "number") search = "" + search;
  else if (typeof search !== "string") search = "";
  search = remapChars(search).trim();
  let info = lowerInfoRemapped(search);
  info.bitflags &= ~SPACE_BIT;
  info.parts = info.hasSpace ? [...new Set(info._lower.split(/\s+/))].map(prepQuery) : [];
  return info;
}
function getPrepared(target) {
  if (target.length > 999) return prepTarget(target);
  let prepared = targetCache.get(target);
  if (prepared === void 0) targetCache.set(target, prepared = prepTarget(target));
  return prepared;
}
function getQuery(search) {
  if (search.length > 999) return prepQuery(search);
  let prepared = searchCache.get(search);
  if (prepared === void 0) {
    if (searchCache.size >= 512) searchCache.clear();
    searchCache.set(search, prepared = prepQuery(search));
  }
  return prepared;
}
function scanBeginnings(prepared, visit) {
  let target = remapChars(prepared.target);
  let wasUpper = false;
  let wasAlnum = false;
  let count = 0;
  for (let i = 0; i < target.length; i++) {
    let code = target.charCodeAt(i);
    let upper = code >= 65 && code <= 90;
    let alnum = upper || code >= 97 && code <= 122 || code >= 48 && code <= 57;
    let beginning = upper && !wasUpper || !wasAlnum || !alnum;
    wasUpper = upper;
    wasAlnum = alnum;
    if (beginning) {
      count++;
      visit(i);
    }
  }
  prepared._beginningsLen = count;
}
function indexBeginnings(prepared, firstTable, row, packed) {
  if (prepared.target.length >= 65535) return;
  let target = remapChars(prepared.target);
  let lowerCodes = prepared._targetLowerCodes;
  let offset = row * 26;
  let wasUpper = false;
  let wasAlnum = false;
  let count = 0;
  for (let i = 0; i < target.length; i++) {
    let code = target.charCodeAt(i);
    let upper = code >= 65 && code <= 90;
    let alnum = upper || code >= 97 && code <= 122 || code >= 48 && code <= 57;
    let beginning = upper && !wasUpper || !wasAlnum || !alnum;
    wasUpper = upper;
    wasAlnum = alnum;
    if (!beginning) continue;
    count++;
    packed.push(i);
    code = lowerCodes[i];
    if (code >= 97 && code <= 122) {
      let slot = offset + code - 97;
      if (firstTable[slot] === 0) firstTable[slot] = i + 1;
    }
  }
  prepared._beginningsLen = count;
}
function prepareSingleMatch(prepared, searchCode, fallbackIndex) {
  let matchI = fallbackIndex;
  let strict = false;
  scanBeginnings(prepared, (i) => {
    if (!strict && searchCode === prepared._targetLowerCodes[i]) {
      matchI = i;
      strict = true;
    }
  });
  prepared._singleMatchCode = searchCode;
  prepared._singleMatchIndex = matchI;
  prepared._singleMatchStrict = strict;
}
function makeBeginnings(prepared) {
  let beginnings = [];
  scanBeginnings(prepared, (i) => beginnings.push(i));
  return beginnings;
}
function makeNextBeginnings(prepared) {
  let next = [];
  let fill = 0;
  scanBeginnings(prepared, (i) => {
    for (; fill < i; fill++) next[fill] = i;
  });
  for (; fill < prepared.target.length; fill++) next[fill] = prepared.target.length;
  return next;
}
function remapCharacter(char) {
  let remapped = remappings[char];
  if (remapped !== void 0) return remapped;
  if (char.charCodeAt(0) < 128) return char;
  remapped = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return remapped.length === 1 ? remapped : char;
}
function remapChars(value) {
  if (customAsciiRemappings) return value.replace(/[\s\S]/g, remapCharacter);
  return /[^\x00-\x7F]|[\\"`]/.test(value) ? value.replace(/[^\x00-\x7F]|[\\"`]/g, remapCharacter) : value;
}
function lowerInfo(value) {
  return lowerInfoRemapped(remapChars(value));
}
function lowerInfoRemapped(value) {
  let lower = value.toLowerCase();
  let lowerCodes = [];
  let bitflags = 0;
  let hasSpace = false;
  for (let i = 0; i < lower.length; i++) {
    let code = lowerCodes[i] = lower.charCodeAt(i);
    if (code === 32) {
      hasSpace = true;
      bitflags |= SPACE_BIT;
      continue;
    }
    let bit = code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? 26 : code <= 127 ? 30 : 31;
    bitflags |= 1 << bit;
  }
  return { lowerCodes, bitflags, hasSpace, _lower: lower };
}
var Result = class {
  get ["indexes"]() {
    return this._indexes.slice(0, this._indexes.len).sort((a, b) => a - b);
  }
  set ["indexes"](value) {
    this._indexes = value;
  }
  ["highlight"](open, close, threshold) {
    return highlight(this, open, close, threshold);
  }
  get ["score"]() {
    return normalizeScore(this._score);
  }
};
var KeysResult = class extends Array {
  get ["score"]() {
    return normalizeScore(this._score);
  }
};
function newResult(target, score2 = -INF, obj = null, lower = "", lowerCodes = null, bitflags = 0) {
  let result = new Result();
  result.target = target;
  result.obj = obj;
  result._score = score2;
  result._indexes = [];
  result._targetLower = lower;
  result._targetLowerCodes = lowerCodes;
  result._nextBeginningIndexes = null;
  result._beginnings = null;
  result._beginningsLen = 0;
  result._singleMatchCode = result._singleMatchIndex = -1;
  result._singleMatchStrict = false;
  result._bitflags = bitflags;
  return result;
}
function materialize(prepared, obj = null) {
  let result = new Result();
  result.target = prepared.target;
  result.obj = obj;
  result._score = prepared._score;
  result._indexes = prepared._indexes;
  return result;
}
function markBestKeyScore(result) {
  let best = -INF;
  for (let i = 0; i < result.length; i++) if (result[i] !== noTarget && result[i]._score > best) best = result[i]._score;
  for (let i = 0; i < result.length; i++) if (result[i] !== noTarget) result[i]._bestKeyScore = best;
  return result;
}
function captureKeysResult(matches, keysLength, obj, score2, partWinners = false) {
  let result = new KeysResult(keysLength);
  for (let k = 0; k < keysLength; k++) result[k] = matches[k];
  result.obj = obj;
  result._score = score2;
  if (partWinners) result._partWinners = true;
  return result;
}
var normalizeScore = (value) => value === -INF ? 0 : value > 1 ? value : Math.E ** (((-value + 1) ** 0.04307 - 1) * -2);
var denormalizeScore = (value) => value === 0 ? -INF : value > 1 ? value : 1 - Math.pow(Math.log(value) / -2 + 1, 1 / 0.04307);
var GOOD_PART_SCORE = denormalizeScore(0.5);
var isPrepared = (value) => typeof value === "object" && typeof value?._bitflags === "number";
function makeGetter(key) {
  if (typeof key === "function") return key;
  let path = Array.isArray(key) ? key : typeof key === "string" && key.includes(".") ? key.split(".") : null;
  if (path === null) return null;
  return (obj) => {
    if (path !== key) {
      let direct = obj[key];
      if (direct !== void 0) return direct;
    }
    for (let i = 0; obj && i < path.length; i++) obj = obj[path[i]];
    return obj;
  };
}
function scoreCeiling(searchLen, targetLen) {
  let lengthPenalty = (targetLen - searchLen) / 2;
  let bonus = 1 + searchLen * searchLen;
  let score2 = -lengthPenalty - lengthPenalty / (bonus * bonus);
  return score2 + Math.min(4, -score2 / 2);
}
function bitCount(value) {
  value -= value >>> 1 & 1431655765;
  value = (value & 858993459) + (value >>> 2 & 858993459);
  return (value + (value >>> 4) & 252645135) * 16843009 >>> 24;
}
function lowerBound(values, start, end, value) {
  while (start < end) {
    let middle = start + end >> 1;
    if (values[middle] < value) start = middle + 1;
    else end = middle;
  }
  return start;
}
function nextBeginning(indexes, start, end, index, targetLen) {
  let next = lowerBound(indexes, start, end, index + 1);
  return next < end ? indexes[next] : targetLen;
}
function isBeginning(indexes, start, end, index) {
  let found = lowerBound(indexes, start, end, index);
  return found < end && indexes[found] === index;
}
function getLimit(options) {
  return (options?.limit ?? 10) || INF;
}
function scheduleTask(run) {
  let id;
  if (typeof requestIdleCallback === "function") {
    id = requestIdleCallback(run, { timeout: 100 });
    return () => typeof cancelIdleCallback === "function" && cancelIdleCallback(id);
  }
  if (typeof setImmediate === "function") {
    id = setImmediate(run);
    return () => typeof clearImmediate === "function" && clearImmediate(id);
  }
  id = setTimeout(run);
  return () => clearTimeout(id);
}
function createHeap() {
  let items = [];
  let length = 0;
  function down() {
    let index = 0;
    let item = items[0];
    for (let child = 1; child < length; child = 1 + index * 2) {
      let right = child + 1;
      index = right < length && items[right]._score < items[child]._score ? right : child;
      items[index - 1 >> 1] = items[index];
    }
    for (let parent = index - 1 >> 1; index > 0 && item._score < items[parent]._score; parent = (index = parent) - 1 >> 1) {
      items[index] = items[parent];
    }
    items[index] = item;
  }
  return {
    add(item) {
      let index = length++;
      for (let parent = index - 1 >> 1; index > 0 && item._score < items[parent]._score; parent = (index = parent) - 1 >> 1) {
        items[index] = items[parent];
      }
      items[index] = item;
    },
    poll() {
      if (!length) return;
      let root = items[0];
      let last = items[--length];
      items[length] = void 0;
      if (length) {
        items[0] = last;
        down();
      }
      return root;
    },
    peek() {
      return length ? items[0] : void 0;
    },
    replaceTop(item) {
      items[0] = item;
      down();
    },
    clear() {
      items.length = length = 0;
    }
  };
}
var INF = Infinity;
var SPACE_BIT = 1 << 27;
var noResults = [];
noResults.total = 0;
var targetCache = /* @__PURE__ */ new Map();
var searchCache = /* @__PURE__ */ new Map();
var simpleMatch = [];
var strictMatch = [];
var seen = [];
var seenAt = [];
var changes = [];
var partials = [];
var spaceScores = [];
var partIndexes = [];
var winnerIndexes = [];
var winnerScores = [];
var winnerKeys = [];
var keyTargets = [];
var keyResults = [];
var candidateBitOffsets = [];
var seenGeneration = 0;
var remappings = {};
var remapFrom = '\\"`\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\xAB\xBB\u2039\u203A\u2010\u2013\u2014\u2212\u2044\u2215\u2026\xF8\xD8\u0142\u0141\u0111\u0110\xF0\xD0\u0131\u0127\u0126\u0167\u0166';
var remapTo = "/''''''''''''''----//.oOlLdDdDihHtT";
for (let i = 0; i < remapFrom.length; i++) remappings[remapFrom[i]] = remapTo[i];
var customAsciiRemappings = false;
var heap = createHeap();
var noTarget = prepTarget("");
var prunedMatch = {};
var fuzzysort_default = { single, go, highlight, score, remap, prepare, snapshot, cleanup };

// src/matcher.ts
var DEFAULT_MIN_INPUT_CHARS = 3;
var DEFAULT_MAX_CANDIDATES = 10;
var DEFAULT_EXCLUDE_PREFIXES = ["/", "@"];
var MIN_CJK_INPUT_UNITS = 2;
var SINGLE_TEXT_UNIT_PATTERN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/gu;
var graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
var ALL_CJK_INPUT_PATTERN = /^[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{3FFFF}]+$/u;
function countTextUnits(text) {
  if (graphemeSegmenter !== null) {
    let graphemeCount = 0;
    for (const _grapheme of graphemeSegmenter.segment(text)) graphemeCount += 1;
    return graphemeCount;
  }
  let textUnitCount = 0;
  for (const _textUnit of text.matchAll(SINGLE_TEXT_UNIT_PATTERN)) textUnitCount += 1;
  return textUnitCount;
}
function isAllCjkText(text) {
  return text.length > 0 && ALL_CJK_INPUT_PATTERN.test(text);
}
function requiredInputUnitCount(trimmedInput, defaultMinChars) {
  const effectiveDefaultMinChars = Math.max(1, Math.floor(defaultMinChars));
  if (isAllCjkText(trimmedInput)) return Math.min(effectiveDefaultMinChars, MIN_CJK_INPUT_UNITS);
  return effectiveDefaultMinChars;
}
function meetsInputLengthRequirement(trimmedInput, defaultMinChars) {
  if (trimmedInput.length === 0) return false;
  return countTextUnits(trimmedInput) >= requiredInputUnitCount(trimmedInput, defaultMinChars);
}
function collectMatchBuckets(history, trimmedInput, maxCandidates) {
  const inputLower = trimmedInput.toLowerCase();
  const prefixMatches = [];
  const substringMatches = [];
  const unmatchedEntries = [];
  for (const historyEntry of history) {
    if (historyEntry.text === trimmedInput) continue;
    if (historyEntry.lower.startsWith(inputLower)) prefixMatches.push(historyEntry);
    else if (historyEntry.lower.includes(inputLower)) substringMatches.push(historyEntry);
    else unmatchedEntries.push(historyEntry);
  }
  const fuzzyMatches = [];
  if (prefixMatches.length + substringMatches.length < maxCandidates) {
    const fuzzyResults = fuzzysort_default.go(inputLower, unmatchedEntries, {
      key: "lower",
      limit: maxCandidates
    });
    for (const fuzzyResult of fuzzyResults) {
      if (fuzzyResult.obj !== void 0) fuzzyMatches.push(fuzzyResult.obj);
    }
  }
  return { prefix: prefixMatches, substring: substringMatches, fuzzy: fuzzyMatches };
}
function findCandidates(history, rawInput, options) {
  const minChars = options.minChars ?? DEFAULT_MIN_INPUT_CHARS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const excludePrefixes = options.excludePrefixes ?? DEFAULT_EXCLUDE_PREFIXES;
  const trimmedInput = rawInput.trim();
  if (!meetsInputLengthRequirement(trimmedInput, minChars)) return [];
  if (maxCandidates <= 0) return [];
  for (const excludePrefix of excludePrefixes) {
    if (excludePrefix.length > 0 && trimmedInput.startsWith(excludePrefix)) return [];
  }
  const matchBuckets = collectMatchBuckets(history, trimmedInput, maxCandidates);
  const seenTexts = /* @__PURE__ */ new Set();
  const mergedCandidates = [];
  for (const historyEntry of [
    ...matchBuckets.prefix,
    ...matchBuckets.substring,
    ...matchBuckets.fuzzy
  ]) {
    if (seenTexts.has(historyEntry.text)) continue;
    seenTexts.add(historyEntry.text);
    mergedCandidates.push(historyEntry);
    if (mergedCandidates.length >= maxCandidates) break;
  }
  return mergedCandidates;
}

// src/suggestion-store.ts
function passesMinInput(text, minChars) {
  return meetsInputLengthRequirement(text, minChars);
}
function createSuggestionStore(history, settings) {
  let currentState = null;
  let dismissedForInput = null;
  const stateChangeListeners = /* @__PURE__ */ new Set();
  function commitState(nextState) {
    if (currentState === nextState) return;
    currentState = nextState;
    for (const stateChangeListener of stateChangeListeners) {
      try {
        stateChangeListener();
      } catch (error) {
        console.warn("[opencode-history-ghost] a state-change listener failed:", error);
      }
    }
  }
  function evaluateInput(rawInput, historyChanged) {
    try {
      if (!settings.enabled) {
        commitState(null);
        return;
      }
      const trimmedInput = rawInput.trim();
      if (!passesMinInput(trimmedInput, settings.minChars)) {
        commitState(null);
        return;
      }
      for (const excludePrefix of settings.excludePrefixes) {
        if (excludePrefix && trimmedInput.startsWith(excludePrefix)) {
          commitState(null);
          return;
        }
      }
      if (dismissedForInput !== null) {
        if (dismissedForInput === trimmedInput) {
          commitState(null);
          return;
        }
        dismissedForInput = null;
      }
      const previousState = currentState;
      if (previousState) {
        if (!historyChanged && previousState.input === trimmedInput) return;
        const shownCandidate = previousState.candidates[previousState.index];
        const inputOnlyExtended = trimmedInput.length > previousState.input.length && trimmedInput.startsWith(previousState.input);
        if (!historyChanged && shownCandidate && inputOnlyExtended && previousState.candidates.length < settings.maxCandidates && previousState.candidates.every(
          (previousCandidate) => previousCandidate.lower.startsWith(trimmedInput.toLowerCase())
        ) && shownCandidate.text !== trimmedInput) {
          commitState({ input: trimmedInput, candidates: previousState.candidates, index: previousState.index });
          return;
        }
      }
      const candidates = findCandidates(history(), trimmedInput, {
        minChars: settings.minChars,
        maxCandidates: settings.maxCandidates,
        excludePrefixes: settings.excludePrefixes
      });
      if (historyChanged && previousState?.input === trimmedInput && candidates.length === previousState.candidates.length && candidates.every((candidate, index) => candidate.text === previousState.candidates[index].text)) return;
      commitState(candidates.length === 0 ? null : { input: trimmedInput, candidates, index: 0 });
    } catch (error) {
      console.warn("[opencode-history-ghost] suggestion evaluation failed:", error);
      commitState(null);
    }
  }
  return {
    evaluate(rawInput) {
      evaluateInput(rawInput, false);
    },
    reassess(rawInput) {
      evaluateInput(rawInput, true);
    },
    cycle(direction) {
      const storeState = currentState;
      if (!storeState || storeState.candidates.length === 0) return;
      const candidateCount = storeState.candidates.length;
      const nextIndex = (storeState.index + direction + candidateCount) % candidateCount;
      commitState({ ...storeState, index: nextIndex });
    },
    clear() {
      commitState(null);
    },
    dismiss() {
      const storeState = currentState;
      if (!storeState) return;
      dismissedForInput = storeState.input;
      commitState(null);
    },
    current() {
      const storeState = currentState;
      if (!storeState) return null;
      return storeState.candidates[storeState.index] ?? null;
    },
    hasSuggestion() {
      return currentState !== null && currentState.candidates.length > 0;
    },
    state() {
      return currentState;
    },
    onStateChange(listener) {
      stateChangeListeners.add(listener);
      return () => {
        stateChangeListeners.delete(listener);
      };
    }
  };
}

// src/string-width.ts
var TAB_CELL_WIDTH = 4;
var ZERO_WIDTH_CODE_POINTS = /* @__PURE__ */ new Set([8203, 8204, 8205, 65038, 65039]);
var WIDE_RANGES = [
  [4352, 4447],
  [11904, 12350],
  [12353, 13311],
  [13312, 19903],
  [19968, 40959],
  [40960, 42191],
  [44032, 55203],
  [63744, 64255],
  [65072, 65103],
  [65280, 65376],
  [65504, 65510],
  [126980, 127183],
  [127744, 128591],
  [128640, 128767],
  [129280, 129535],
  [131072, 262141]
];
var graphemeSegmenter2;
function splitGraphemes(text) {
  if (!text) return [];
  if (graphemeSegmenter2 === void 0) {
    const SegmenterConstructor = Intl.Segmenter;
    graphemeSegmenter2 = SegmenterConstructor ? new SegmenterConstructor(void 0, { granularity: "grapheme" }) : null;
  }
  if (graphemeSegmenter2) return Array.from(graphemeSegmenter2.segment(text), (piece) => piece.segment);
  return Array.from(text);
}
function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (grapheme === "	") return TAB_CELL_WIDTH;
  const codePoint = grapheme.codePointAt(0) ?? 0;
  if (codePoint < 32) return 0;
  if (ZERO_WIDTH_CODE_POINTS.has(codePoint)) return 0;
  const terminalWidth = globalThis.Bun?.stringWidth;
  if (typeof terminalWidth === "function") return terminalWidth(grapheme);
  return WIDE_RANGES.some(([rangeStart, rangeEnd]) => codePoint >= rangeStart && codePoint <= rangeEnd) ? 2 : 1;
}
function stringWidth(text) {
  let width = 0;
  for (const grapheme of splitGraphemes(text)) width += graphemeWidth(grapheme);
  return width;
}
function clampToCellBudget(text, cellBudget) {
  if (!(cellBudget > 0)) return "";
  let usedCells = 0;
  let keptText = "";
  for (const grapheme of splitGraphemes(text)) {
    const nextCellWidth = graphemeWidth(grapheme);
    if (usedCells + nextCellWidth > cellBudget) break;
    usedCells += nextCellWidth;
    keptText += grapheme;
  }
  return keptText;
}

// src/ghost-overlay.tsx
var YOGA_POINT_UNIT = 1;
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function computeInlineSuffixFromPrefix(textBeforeCaret, candidateText) {
  if (typeof candidateText !== "string" || candidateText.length === 0) return null;
  if (typeof textBeforeCaret !== "string") return null;
  const typedLinePrefix = textBeforeCaret.slice(textBeforeCaret.lastIndexOf("\n") + 1);
  const trimmedPrefix = textBeforeCaret.trim();
  const candidateHead = candidateText.slice(0, trimmedPrefix.length);
  if (candidateHead.toLowerCase() !== trimmedPrefix.toLowerCase()) return null;
  const remainder = candidateText.slice(trimmedPrefix.length);
  if (remainder.length === 0) return null;
  const newlineIndex = remainder.indexOf("\n");
  const suffix = newlineIndex === -1 ? remainder : remainder.slice(0, newlineIndex);
  if (suffix.length === 0) return null;
  return { suffix, typedLinePrefix, continuesOnNextLine: newlineIndex !== -1 };
}
function paddingCells(editor, edge) {
  if (typeof editor.getPadding !== "function") return null;
  const paddingValue = editor.getPadding(edge);
  if (!paddingValue || paddingValue.unit !== YOGA_POINT_UNIT || !isFiniteNumber(paddingValue.value)) return null;
  return Math.max(0, Math.trunc(paddingValue.value));
}
function numericLayoutValue(value) {
  if (isFiniteNumber(value)) return value;
  return null;
}
function resolveOverlayGeometry(editor, inlineSuffix, caretCell) {
  if (!editor || editor.isDestroyed === true) return null;
  const textareaX = isFiniteNumber(editor.screenX) ? editor.screenX : numericLayoutValue(editor.x);
  const textareaY = isFiniteNumber(editor.screenY) ? editor.screenY : numericLayoutValue(editor.y);
  const textareaWidth = numericLayoutValue(editor.width);
  if (textareaX === null || textareaY === null) return null;
  if (textareaWidth === null || textareaWidth <= 0) return null;
  const paddingLeftCells = paddingCells(editor, 0);
  const paddingRightCells = paddingCells(editor, 2) ?? 0;
  const paddingTopCells = paddingCells(editor, 1);
  if (paddingLeftCells === null || paddingTopCells === null) return null;
  if (!Number.isSafeInteger(caretCell.row) || caretCell.row < 0) return null;
  if (!isFiniteNumber(caretCell.col) || caretCell.col < 0) return null;
  const visualCursor = editor.visualCursor;
  const hasVisualCursor = visualCursor !== void 0 && Number.isSafeInteger(visualCursor.visualRow) && Number.isSafeInteger(visualCursor.visualCol) && visualCursor.visualRow >= 0 && visualCursor.visualCol >= 0;
  let screenRow;
  let screenColumn;
  if (hasVisualCursor) {
    screenRow = visualCursor.visualRow;
    screenColumn = visualCursor.visualCol;
  } else {
    if (editor.scrollY !== void 0 && !isFiniteNumber(editor.scrollY)) return null;
    if (editor.textBufferView?.scrollX !== void 0 && !isFiniteNumber(editor.textBufferView.scrollX)) return null;
    screenRow = caretCell.row - Math.max(0, Math.trunc(editor.scrollY ?? 0));
    screenColumn = caretCell.col - Math.max(0, Math.trunc(editor.textBufferView?.scrollX ?? 0));
  }
  const contentWidthCells = Math.trunc(textareaWidth) - paddingLeftCells - paddingRightCells;
  if (contentWidthCells <= 0) return null;
  const suffixStartColumn = paddingLeftCells + screenColumn;
  const suffixStartRow = paddingTopCells + screenRow;
  if (suffixStartColumn < 0) return null;
  const contentHeightCells = numericLayoutValue(editor.height);
  if (contentHeightCells === null || suffixStartRow < 0 || suffixStartRow >= contentHeightCells) return null;
  return {
    x: textareaX + suffixStartColumn,
    y: textareaY + suffixStartRow,
    availableCells: contentWidthCells - screenColumn,
    suffix: inlineSuffix.suffix
  };
}

// src/ghost-overlay-render.tsx
import { jsx } from "@opentui/solid/jsx-runtime";
var ELLIPSIS = "\u2026";
function fitSuffixToWidth(suffix, availableCells) {
  if (availableCells <= 0) return "";
  const keptText = clampToCellBudget(suffix, availableCells);
  if (keptText.length === suffix.length) return keptText;
  if (keptText.length === 0) return "";
  const keptWithRoomForEllipsis = clampToCellBudget(suffix, availableCells - 1);
  if (keptWithRoomForEllipsis.length === 0) return "";
  return `${keptWithRoomForEllipsis}${ELLIPSIS}`;
}
function resolveCaretPrefixText(editor) {
  const offset = editor.cursorOffset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return null;
  const buffer = editor.editBuffer;
  if (buffer && typeof buffer.getTextRange === "function" && typeof buffer.measureText === "function") {
    try {
      const text = editor.plainText;
      if (typeof text !== "string") return null;
      const end = buffer.measureText(text);
      if (offset > end) return null;
      const prefix = buffer.getTextRange(0, offset);
      if (prefix + buffer.getTextRange(offset, end) !== text) return null;
      return prefix;
    } catch {
      return null;
    }
  }
  const plainText = editor.plainText;
  if (typeof plainText === "string" && offset <= plainText.length) return plainText.slice(0, offset);
  return null;
}
function caretCellFromPrefix(textBeforeCaret) {
  const lastNewlineIndex = textBeforeCaret.lastIndexOf("\n");
  return {
    row: textBeforeCaret.split("\n").length - 1,
    col: stringWidth(textBeforeCaret.slice(lastNewlineIndex + 1))
  };
}
function planInlineRender(store, editorSource) {
  if (!editorSource) return null;
  const suggestionState = store.state();
  const candidate = suggestionState?.candidates[suggestionState.index];
  if (!suggestionState || !candidate) return null;
  const editor = editorSource.currentEditor();
  if (!editor || editor.isDestroyed === true) return null;
  if (typeof editor.plainText !== "string" || editor.plainText.length === 0) return null;
  const textBeforeCaret = resolveCaretPrefixText(editor);
  if (textBeforeCaret === null) return null;
  const caretCell = caretCellFromPrefix(textBeforeCaret);
  const inlineSuffix = computeInlineSuffixFromPrefix(textBeforeCaret, candidate.text);
  if (!inlineSuffix) return null;
  const geometry = resolveOverlayGeometry(editor, inlineSuffix, caretCell);
  if (!geometry) return null;
  const fittedText = fitSuffixToWidth(geometry.suffix, geometry.availableCells);
  if (fittedText.length === 0) return null;
  return { text: fittedText, x: geometry.x, y: geometry.y };
}
function createInlineGhostOverlay(deps) {
  const themeText = deps.theme?.text ?? deps.theme?.colors;
  const mutedColor = themeText?.muted ?? "gray";
  const mountedOverlays = /* @__PURE__ */ new Set();
  function readContainerOrigin(overlay) {
    const anchorBox = overlay.anchorBox;
    if (!anchorBox) {
      overlay.originColumn = null;
      overlay.originRow = null;
      return false;
    }
    try {
      const x = anchorBox.screenX;
      const y = anchorBox.screenY;
      if (typeof x !== "number" || !Number.isFinite(x)) {
        overlay.originColumn = null;
        overlay.originRow = null;
        return false;
      }
      if (typeof y !== "number" || !Number.isFinite(y)) {
        overlay.originColumn = null;
        overlay.originRow = null;
        return false;
      }
      overlay.originColumn = x;
      overlay.originRow = y;
      return true;
    } catch {
      overlay.originColumn = null;
      overlay.originRow = null;
      return false;
    }
  }
  function patchOverlay(overlay) {
    const suffixText = overlay.suffixText;
    const positionBox = overlay.positionBox;
    const anchorBox = overlay.anchorBox;
    if (!suffixText || !positionBox || !anchorBox) return;
    if (suffixText.isDestroyed || positionBox.isDestroyed || anchorBox.isDestroyed) {
      mountedOverlays.delete(overlay);
      return;
    }
    mountedOverlays.add(overlay);
    const hasContainerOrigin = readContainerOrigin(overlay);
    let plan = null;
    try {
      plan = planInlineRender(deps.store, deps.editorSource);
    } catch {
      plan = null;
    }
    if (plan && hasContainerOrigin && overlay.originColumn !== null && overlay.originRow !== null) {
      suffixText.content = plan.text;
      positionBox.left = plan.x - overlay.originColumn;
      positionBox.top = plan.y - overlay.originRow;
      suffixText.visible = true;
    } else {
      suffixText.visible = false;
    }
  }
  return {
    renderOverlay() {
      const mountedOverlay = {
        suffixText: null,
        positionBox: null,
        anchorBox: null,
        originColumn: null,
        originRow: null
      };
      mountedOverlays.add(mountedOverlay);
      return /* @__PURE__ */ jsx(
        "box",
        {
          width: 0,
          height: 0,
          focusable: false,
          ref: (anchorRenderable) => {
            mountedOverlay.anchorBox = anchorRenderable ?? null;
            patchOverlay(mountedOverlay);
          },
          children: /* @__PURE__ */ jsx(
            "box",
            {
              position: "absolute",
              left: 0,
              top: 0,
              zIndex: 1e3,
              ref: (positionRenderable) => {
                mountedOverlay.positionBox = positionRenderable ?? null;
                patchOverlay(mountedOverlay);
              },
              children: /* @__PURE__ */ jsx(
                "text",
                {
                  fg: mutedColor,
                  ref: (textRenderable) => {
                    mountedOverlay.suffixText = textRenderable ?? null;
                    patchOverlay(mountedOverlay);
                  }
                }
              )
            }
          )
        }
      );
    },
    refresh() {
      for (const overlay of [...mountedOverlays]) {
        if (overlay.suffixText?.isDestroyed === true) {
          mountedOverlays.delete(overlay);
          continue;
        }
        patchOverlay(overlay);
      }
    }
  };
}

// src/ghost-line.tsx
import { jsx as jsx2, jsxs } from "@opentui/solid/jsx-runtime";
var MAX_DISPLAY_CODE_UNITS = 100;
function acceptKeyLabel(acceptKey) {
  if (acceptKey === "tab") return "Tab";
  if (acceptKey === "right") return "\u2192";
  return acceptKey;
}
function computeSegments(settings, suggestionState, candidate) {
  const typedInput = suggestionState.input;
  const inputLower = typedInput.toLowerCase();
  const [firstLine, ...restLines] = candidate.text.split("\n");
  const extraLineCount = restLines.length;
  const multilineNote = extraLineCount > 0 ? ` (+${extraLineCount} \u884C)` : "";
  const displayFirstLine = firstLine.length > MAX_DISPLAY_CODE_UNITS ? `${firstLine.slice(0, MAX_DISPLAY_CODE_UNITS)}\u2026` : firstLine;
  let leadingDim = "";
  let typedMatch = "";
  let trailingDim = displayFirstLine;
  const matchStart = candidate.lower.indexOf(inputLower);
  if (typedInput.length > 0 && matchStart >= 0) {
    leadingDim = displayFirstLine.slice(0, matchStart);
    typedMatch = displayFirstLine.slice(matchStart, matchStart + typedInput.length);
    trailingDim = displayFirstLine.slice(matchStart + typedInput.length);
  }
  const hint = `${acceptKeyLabel(settings.acceptKey)} \u63A5\u53D7 \xB7 (${suggestionState.index + 1}/${suggestionState.candidates.length}) ctrl+\u2191\u2193 \u5207\u6362 \xB7 Esc \u53D6\u6D88`;
  return { leadingDim, typedMatch, trailingDim, multilineNote, hint };
}
function createGhostLine(deps) {
  const themeText = deps.theme?.text;
  const dimColor = themeText?.muted ?? "gray";
  const baseColor = themeText?.base;
  const mountedRows = /* @__PURE__ */ new Set();
  const inlineOverlay = deps.editorSource ? createInlineGhostOverlay({ store: deps.store, editorSource: deps.editorSource, theme: deps.theme }) : null;
  function patchFromState(mount) {
    const textRenderables = Object.values(mount.textRenderables);
    if (!mount.rowBox || textRenderables.some((renderable) => !renderable)) return;
    if (mount.rowBox.isDestroyed || textRenderables.some((renderable) => renderable.isDestroyed)) {
      mountedRows.delete(mount);
      return;
    }
    mountedRows.add(mount);
    const suggestionState = deps.store.state();
    const candidate = suggestionState?.candidates[suggestionState.index];
    if (!suggestionState || !candidate) {
      mount.rowBox.visible = false;
      return;
    }
    mount.rowBox.visible = true;
    const segments = computeSegments(deps.settings, suggestionState, candidate);
    for (const fieldName of Object.keys(mount.textRenderables)) {
      mount.textRenderables[fieldName].content = segments[fieldName];
    }
  }
  function retainTextRenderable(mount, fieldName, renderable) {
    mount.textRenderables[fieldName] = renderable ?? null;
    patchFromState(mount);
  }
  return {
    renderRow() {
      const mount = {
        rowBox: null,
        textRenderables: {
          leadingDim: null,
          typedMatch: null,
          trailingDim: null,
          multilineNote: null,
          hint: null
        }
      };
      return /* @__PURE__ */ jsxs(
        "box",
        {
          flexDirection: "row",
          ref: (rowRenderable) => {
            mount.rowBox = rowRenderable ?? null;
            patchFromState(mount);
          },
          children: [
            /* @__PURE__ */ jsx2(
              "text",
              {
                fg: dimColor,
                ref: (textRenderable) => retainTextRenderable(mount, "leadingDim", textRenderable)
              }
            ),
            /* @__PURE__ */ jsx2(
              "text",
              {
                fg: baseColor,
                ref: (textRenderable) => retainTextRenderable(mount, "typedMatch", textRenderable)
              }
            ),
            /* @__PURE__ */ jsx2(
              "text",
              {
                fg: dimColor,
                ref: (textRenderable) => retainTextRenderable(mount, "trailingDim", textRenderable)
              }
            ),
            /* @__PURE__ */ jsx2(
              "text",
              {
                fg: dimColor,
                ref: (textRenderable) => retainTextRenderable(mount, "multilineNote", textRenderable)
              }
            ),
            /* @__PURE__ */ jsx2("box", { flexGrow: 1, flexShrink: 0 }),
            /* @__PURE__ */ jsx2(
              "text",
              {
                fg: dimColor,
                ref: (textRenderable) => retainTextRenderable(mount, "hint", textRenderable)
              }
            )
          ]
        }
      );
    },
    refresh() {
      for (const mount of mountedRows) patchFromState(mount);
      inlineOverlay?.refresh();
    },
    renderInlineOverlay() {
      return inlineOverlay ? inlineOverlay.renderOverlay() : null;
    }
  };
}

// src/probe-log.ts
import * as fs from "node:fs";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/thrown-dump.ts
function describeThrownValue(thrown) {
  const lines = [];
  lines.push(`typeof=${typeof thrown}`);
  try {
    lines.push(`String()=${String(thrown)}`);
  } catch (error) {
    lines.push(`String() threw ${String(error)}`);
  }
  if (thrown && typeof thrown === "object") {
    const candidate = thrown;
    lines.push(`name=${String(candidate.name)}`);
    lines.push(`message=${String(candidate.message)}`);
    lines.push(`code=${String(candidate.code)}`);
    lines.push(`stack=${String(candidate.stack)}`);
    try {
      lines.push(`ownKeys=${Object.keys(thrown).join(",")}`);
    } catch {
    }
  }
  return lines.join("\n");
}

// src/probe-log.ts
var PROBE_DIRECTORY = join2(dirname(fileURLToPath(import.meta.url)), "..");
var PROBE_PATH = join2(PROBE_DIRECTORY, "probe-slot-errors.txt");
function probeFilePath(fileName) {
  return join2(PROBE_DIRECTORY, fileName);
}
function recordFailure(stage, thrown) {
  try {
    fs.appendFileSync(PROBE_PATH, `${(/* @__PURE__ */ new Date()).toISOString()} pid=${typeof process !== "undefined" ? process.pid : "?"} stage=${stage}
${describeThrownValue(thrown)}
---
`);
  } catch {
  }
}
function recordEvent(stage) {
  try {
    fs.appendFileSync(PROBE_PATH, `${(/* @__PURE__ */ new Date()).toISOString()} pid=${typeof process !== "undefined" ? process.pid : "?"} event=${stage}
`);
  } catch {
  }
}

// src/keymap.ts
var LOG_PREFIX2 = "[opencode-history-ghost]";
function safeInputMode(keymap) {
  try {
    return keymap.mode?.current() ?? "";
  } catch (error) {
    recordFailure("keymap.mode", error);
    return "";
  }
}
function isHostOverlayMode(keymap) {
  const inputMode = safeInputMode(keymap);
  return inputMode === "autocomplete" || inputMode === "modal";
}
function suggestionMatchesFocusedEditor(deps, candidateSnapshot) {
  if (!deps.settings.enabled) return false;
  const suggestionState = deps.store.state();
  if (!suggestionState) return false;
  const current = deps.bridge.caretSnapshot();
  if (!current || !candidateSnapshot) return false;
  if (current.editor !== candidateSnapshot.editor) return false;
  if (current.text !== candidateSnapshot.text || current.prefix !== candidateSnapshot.prefix || current.offset !== candidateSnapshot.offset) return false;
  return current.prefix.trim() === suggestionState.input;
}
function caretAtTextEnd(snapshot2) {
  return snapshot2.prefix === snapshot2.text;
}
function registerKeymap(context, deps) {
  const keymap = context?.keymap;
  if (!keymap || typeof keymap.layer !== "function") {
    console.warn(`${LOG_PREFIX2} keymap API unavailable; history-ghost shortcuts are disabled`);
    const unavailableCleanup = () => {
    };
    Object.defineProperty(unavailableCleanup, "suggestionLayerRegistered", {
      value: false,
      enumerable: true
    });
    return unavailableCleanup;
  }
  let candidateSnapshot = deps.store.hasSuggestion() ? deps.bridge.caretSnapshot() : null;
  const stopSnapshotListening = deps.store.onStateChange(() => {
    candidateSnapshot = deps.store.hasSuggestion() ? deps.bridge.caretSnapshot() : null;
  });
  const requestRender = () => {
    try {
      ;
      context?.renderer?.requestRender?.();
    } catch {
    }
  };
  const layerDisposers = [];
  let suggestionLayerRegistered = false;
  try {
    const layerResult = keymap.layer(() => ({
      mode: "global",
      // NO `target` and NO `enabled` here. The host resolves a layer's `target`
      // thunk to a STATIC reference once, untracked, and REPLACES the layer with
      // undefined — i.e. removes it — when that call returns null. `target:
      // () => deps.bridge.current()` is null until the composer is proven, so
      // the whole layer was deleted at activation and every shortcut died
      // (real-machine: Tab/right/ctrl+up/ctrl+down all no-ops). This mirrors the
      // two working same-host plugins (opencode-autocontinue, opencode-snippets),
      // which declare only `mode: "global"` + `commands` and gate inside run().
      // All real gating stays in each run() below.
      commands: [
        {
          id: "history-ghost.accept",
          title: "History Ghost: \u63A5\u53D7\u5EFA\u8BAE",
          bind: deps.settings.acceptKey,
          run: () => {
            const candidate = deps.store.current();
            if (!candidate) return false;
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false;
            if (!deps.bridge.acceptFullText(candidate.text)) return false;
            deps.store.clear();
            requestRender();
          }
        },
        {
          // "right" is a second accept key, not a replacement for acceptKey.
          // It only fires with the caret past the last typed character, so
          // ordinary caret movement keeps working untouched.
          id: "history-ghost.accept-forward",
          title: "History Ghost: \u63A5\u53D7\u5EFA\u8BAE\uFF08\u53F3\u7BAD\u5934\uFF09",
          bind: "right",
          run: () => {
            if (isHostOverlayMode(keymap)) return false;
            if (!suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false;
            const liveSnapshot = deps.bridge.caretSnapshot();
            if (!liveSnapshot || !caretAtTextEnd(liveSnapshot)) return false;
            const candidate = deps.store.current();
            if (!candidate) return false;
            if (!deps.bridge.acceptFullText(candidate.text)) return false;
            deps.store.clear();
            requestRender();
          }
        },
        {
          id: "history-ghost.cycle-next",
          title: "History Ghost: \u4E0B\u4E00\u6761\u5EFA\u8BAE",
          bind: "ctrl+down",
          run: () => {
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false;
            deps.store.cycle(1);
            requestRender();
          }
        },
        {
          id: "history-ghost.cycle-prev",
          title: "History Ghost: \u4E0A\u4E00\u6761\u5EFA\u8BAE",
          bind: "ctrl+up",
          run: () => {
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false;
            deps.store.cycle(-1);
            requestRender();
          }
        },
        {
          id: "history-ghost.dismiss",
          title: "History Ghost: \u53D6\u6D88\u5EFA\u8BAE",
          bind: "escape",
          run: () => {
            if (isHostOverlayMode(keymap) || !suggestionMatchesFocusedEditor(deps, candidateSnapshot)) return false;
            deps.store.dismiss();
            requestRender();
          }
        }
      ]
    }));
    if (typeof layerResult?.dispose === "function") {
      layerDisposers.push(layerResult.dispose);
    } else if (typeof layerResult === "function") {
      layerDisposers.push(layerResult);
    }
    suggestionLayerRegistered = true;
  } catch (error) {
    recordFailure("keymap.suggestion", error);
    console.warn(`${LOG_PREFIX2} suggestion keymap layer registration failed:`, error);
  }
  try {
    const toggleLayerResult = keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "history-ghost.toggle",
        title: "History Ghost: \u5F00\u5173\u5386\u53F2\u5EFA\u8BAE",
        palette: true,
        run: () => {
          deps.onToggle();
        }
      }]
    }));
    if (typeof toggleLayerResult?.dispose === "function") {
      layerDisposers.push(toggleLayerResult.dispose);
    } else if (typeof toggleLayerResult === "function") {
      layerDisposers.push(toggleLayerResult);
    }
  } catch (error) {
    recordFailure("keymap.toggle", error);
    console.warn(`${LOG_PREFIX2} palette keymap layer registration failed:`, error);
  }
  const cleanup2 = () => {
    stopSnapshotListening();
    for (const disposeLayer of layerDisposers.reverse()) {
      try {
        disposeLayer();
      } catch (error) {
        recordFailure("keymap.dispose", error);
        console.warn(`${LOG_PREFIX2} keymap layer unregistration failed:`, error);
      }
    }
  };
  Object.defineProperty(cleanup2, "suggestionLayerRegistered", {
    value: suggestionLayerRegistered,
    enumerable: true
  });
  return cleanup2;
}

// src/context-probe.ts
import * as fs2 from "node:fs";
var PROBE_FILE = probeFilePath("probe-context-shape.txt");
function describeValue(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  const valueType = typeof value;
  if (valueType === "object" || valueType === "function") {
    const own = [];
    const proto = [];
    try {
      for (const name of Object.keys(value).slice(0, 40)) own.push(name);
    } catch {
    }
    try {
      let cursor = Object.getPrototypeOf(value);
      let depth = 0;
      while (cursor && depth < 3 && cursor !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(cursor)) {
          if (name === "constructor") continue;
          if (own.includes(name) || proto.includes(name)) continue;
          proto.push(name);
        }
        cursor = Object.getPrototypeOf(cursor);
        depth += 1;
      }
    } catch {
    }
    return `${valueType} own=[${own.join(",")}] proto=[${proto.join(",")}]`;
  }
  return `${valueType}`;
}
function probeContextShape(context) {
  const lines = [];
  lines.push(`=== ${(/* @__PURE__ */ new Date()).toISOString()} pid=${process.pid} ===`);
  try {
    const keys = Object.keys(context ?? {});
    lines.push(`top-level keys: ${keys.join(",")}`);
    for (const key of keys) {
      let value;
      try {
        value = context[key];
      } catch (error) {
        lines.push(`${key}: read threw ${String(error)}`);
        continue;
      }
      lines.push(`${key}: ${describeValue(value)}`);
    }
    const ui = context?.ui;
    if (ui) {
      lines.push(`ui: ${describeValue(ui)}`);
      for (const uiKey of Object.keys(ui)) {
        lines.push(`ui.${uiKey}: ${describeValue(ui[uiKey])}`);
      }
    } else {
      lines.push("ui: ABSENT");
    }
  } catch (error) {
    lines.push(`probe failed: ${String(error)}`);
  }
  try {
    fs2.appendFileSync(PROBE_FILE, lines.join("\n") + "\n");
  } catch {
  }
}

// src/tui.tsx
import { jsx as jsx3 } from "@opentui/solid/jsx-runtime";
var HISTORY_REFRESH_INTERVAL_MS = 3e3;
function defaultSettings() {
  return {
    enabled: true,
    acceptKey: "tab",
    minChars: 3,
    maxCandidates: 10,
    maxEntries: 2e3,
    maxTextLength: 2e3,
    excludePrefixes: ["/", "@"]
  };
}
var tui_default = Plugin.define({
  id: "history-ghost",
  setup(context) {
    if (typeof context?.ui?.slot !== "function") return;
    try {
      probeContextShape(context);
    } catch {
    }
    try {
      const runtimeRole = context?.ui?.slot ? "client" : "server";
      fs3.appendFileSync(
        probeFilePath("probe-runtime-role.txt"),
        `${(/* @__PURE__ */ new Date()).toISOString()} pid=${typeof process !== "undefined" ? process.pid : "?"} role=${runtimeRole} bootstrap=${Object.prototype.hasOwnProperty.call(context, "bootstrap")} ui=${typeof context?.ui}
`
      );
    } catch {
    }
    let resolvedSettings;
    let updateSettings;
    try {
      const settingsPair = context.storage?.store?.("history-ghost-settings", {
        initial: defaultSettings()
      });
      if (settingsPair && settingsPair[0]) {
        resolvedSettings = settingsPair[0];
        updateSettings = settingsPair[1];
      }
    } catch (error) {
      recordFailure("settings.store", error);
      console.warn("[opencode-history-ghost] settings storage unavailable; using in-memory defaults:", error);
    }
    const settings = resolvedSettings ?? defaultSettings();
    const historySource = createHistorySource({
      maxEntries: settings.maxEntries,
      maxTextLength: settings.maxTextLength
    });
    const composerIdentity = createComposerIdentity(context);
    const editorBridge = createEditorBridge(context, composerIdentity);
    const suggestionStore = createSuggestionStore(() => historySource.entries(), settings);
    const ghostLine = createGhostLine({
      store: suggestionStore,
      settings,
      theme: context.theme,
      // The inline grey suffix overlays the proven composer textarea. The
      // bridge's current() already limits focus to the trusted composer, so it
      // is the single safe source for the overlay's geometry.
      editorSource: { currentEditor: () => editorBridge.current() }
    });
    let observedHistoryEntries = historySource.entries();
    let disposed = false;
    const requestRender = () => {
      try {
        context?.renderer?.requestRender?.();
      } catch {
      }
    };
    const stopStateListening = suggestionStore.onStateChange(() => {
      ghostLine.refresh();
      requestRender();
    });
    const evaluateCaretPrefix = () => {
      try {
        const prefix = editorBridge.caretPrefix();
        if (prefix === null) suggestionStore.clear();
        else suggestionStore.evaluate(prefix);
      } catch (error) {
        recordFailure("input.evaluate", error);
        console.warn("[opencode-history-ghost] input handling failed:", error);
      }
    };
    const reassessChangedHistory = () => {
      if (disposed) return;
      const latestEntries = historySource.entries();
      if (latestEntries === observedHistoryEntries) return;
      observedHistoryEntries = latestEntries;
      try {
        const prefix = editorBridge.caretPrefix();
        if (prefix === null) suggestionStore.clear();
        else suggestionStore.reassess(prefix);
      } catch (error) {
        recordFailure("input.reassess", error);
        console.warn("[opencode-history-ghost] history re-assessment failed:", error);
      }
    };
    void historySource.whenReady?.().then(reassessChangedHistory, (error) => {
      if (!disposed) console.warn("[opencode-history-ghost] history readiness failed:", error);
    });
    const stopInputListening = editorBridge.onInput(evaluateCaretPrefix);
    const stopCaretListening = editorBridge.onCaretMove(() => {
      evaluateCaretPrefix();
      ghostLine.refresh();
    });
    const stopForeignFocusListening = editorBridge.onForeignEditorFocus(() => {
      suggestionStore.clear();
    });
    editorBridge.watch();
    let stopIdentitySlot;
    try {
      const identitySlotResult = context.ui?.slot?.({
        append: "prompt.footer",
        render: (properties) => /* @__PURE__ */ jsx3("box", { width: 0, height: 0, focusable: false, ref: (marker) => {
          if (marker && properties.sessionID) composerIdentity.register(properties.sessionID, marker);
        } })
      });
      if (typeof identitySlotResult?.dispose === "function") stopIdentitySlot = identitySlotResult.dispose;
      else if (typeof identitySlotResult === "function") stopIdentitySlot = identitySlotResult;
    } catch (error) {
      recordFailure("slot.prompt.footer", error);
      console.warn("[opencode-history-ghost] footer identity slot unavailable:", error);
    }
    const onToggle = () => {
      const nextEnabled = !settings.enabled;
      try {
        if (updateSettings) {
          void updateSettings((draft) => {
            draft.enabled = nextEnabled;
          });
        } else {
          settings.enabled = nextEnabled;
        }
      } catch (error) {
        try {
          settings.enabled = nextEnabled;
        } catch {
        }
        console.warn("[opencode-history-ghost] settings toggle failed:", error);
      }
      suggestionStore.clear();
      requestRender();
      try {
        context?.ui?.toast?.show?.({
          title: "History Ghost",
          message: nextEnabled ? "\u5386\u53F2\u5EFA\u8BAE\u5DF2\u5F00\u542F" : "\u5386\u53F2\u5EFA\u8BAE\u5DF2\u5173\u95ED",
          variant: nextEnabled ? "success" : "info"
        });
      } catch {
      }
    };
    let keymapCleanup;
    let stopAppSlot;
    try {
      const appSlotResult = context.ui?.slot?.({
        append: "app",
        render: () => {
          recordEvent("app.render");
          if (keymapCleanup === void 0) {
            const registration = registerKeymap(context, {
              bridge: editorBridge,
              store: suggestionStore,
              settings,
              onToggle
            });
            if (registration.suggestionLayerRegistered) keymapCleanup = registration;
          }
          return null;
        }
      });
      if (typeof appSlotResult?.dispose === "function") stopAppSlot = appSlotResult.dispose;
      else if (typeof appSlotResult === "function") stopAppSlot = appSlotResult;
    } catch (error) {
      recordFailure("slot.app", error);
      console.warn("[opencode-history-ghost] app slot registration failed:", error);
    }
    let stopComposerSlot;
    try {
      const slotResult = context.ui?.slot?.({
        append: "session.composer.top",
        render: () => ghostLine.renderRow()
      });
      if (typeof slotResult?.dispose === "function") stopComposerSlot = slotResult.dispose;
      else if (typeof slotResult === "function") stopComposerSlot = slotResult;
    } catch (error) {
      recordFailure("slot.session.composer.top", error);
      console.warn("[opencode-history-ghost] composer slot registration failed:", error);
    }
    let stopOverlaySlot;
    try {
      const slotResult = context.ui?.slot?.({
        append: "session.composer.top",
        render: () => ghostLine.renderInlineOverlay()
      });
      if (typeof slotResult?.dispose === "function") stopOverlaySlot = slotResult.dispose;
      else if (typeof slotResult === "function") stopOverlaySlot = slotResult;
    } catch (error) {
      recordFailure("slot.overlay", error);
      console.warn("[opencode-history-ghost] composer overlay slot registration failed:", error);
    }
    const historyRefreshTimer = setInterval(() => {
      if (disposed) return;
      try {
        historySource.refresh();
        reassessChangedHistory();
      } catch (error) {
        recordFailure("history.refresh", error);
        console.warn("[opencode-history-ghost] history refresh failed:", error);
      }
    }, HISTORY_REFRESH_INTERVAL_MS);
    function disposeAll() {
      if (disposed) return;
      disposed = true;
      clearInterval(historyRefreshTimer);
      stopStateListening();
      stopInputListening();
      stopCaretListening();
      stopForeignFocusListening();
      editorBridge.dispose();
      composerIdentity.dispose();
      keymapCleanup?.();
      stopAppSlot?.();
      stopComposerSlot?.();
      stopOverlaySlot?.();
      stopIdentitySlot?.();
    }
    return disposeAll;
  }
});
export {
  tui_default as default
};
