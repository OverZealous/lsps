import type { Editor, Position } from "codemirror";
import { normalizeKeyMap } from "codemirror";
import {
  CompletionTriggerKind,
  SignatureHelpTriggerKind,
  DiagnosticTag,
  TextDocumentSaveReason,
} from "vscode-languageserver-protocol";

import { createMessageConnection as createWebSocketMessageConnection } from "@qualified/vscode-jsonrpc-ws";
import { createMessageConnection as createWorkerMessageConnection } from "@qualified/vscode-jsonrpc-ww";
import { createLspConnection, LspConnection } from "@qualified/lsp-connection";

import {
  showDiagnostics,
  removeDiagnostics,
  showHoverInfo,
  removeHoverInfo,
  hoverInfoEnabled,
  disableHoverInfo,
  enableHoverInfo,
  showHighlights,
  removeHighlights,
  showInvokedCompletions,
  showTriggeredCompletions,
  hideCompletions,
  showSignatureHelp,
  removeSignatureHelp,
  gotoLocation,
  showSymbolSelector,
} from "./capabilities";
import {
  debounce,
  filter,
  fromDomEvent,
  map,
  piped,
  skipDuplicates,
  Disposer,
  debouncedBuffer,
} from "./utils/event-stream";
import { fromEditorEvent, onEditorEvent } from "./events";
import { lspPosition, lspChange } from "./utils/conversions";
import { applyEdits } from "./utils/editor";
import { delay } from "./utils/promise";
import { showContextMenu } from "./ui/context-menu";

// Changes stream emits at most once per 50ms.
const CHANGES_FRAME = 50;

/**
 * Describes text document's language association.
 */
export interface LanguageAssociation {
  /**
   * Language ID associated with the file.
   */
  languageId: string;
  /**
   * IDs of language servers to connect to.
   * Accepts multiple IDs for future extension, but currently only the first one is used.
   */
  languageServerIds: string[];
}

/**
 * Options for Workspace.
 */
export interface WorkspaceOptions {
  /**
   * The URI of the project root.
   */
  rootUri: string;
  /**
   * Provide Language Server connection string.
   *
   * The returned string can be either:
   *
   * - URI of a WebSocket proxy of a Language Server (`wss?://`)
   * - Path to a script to start Language Server in Web Worker
   *
   * If the returned string does not start with `wss?://`, it's assumed to be a Worker script.
   */
  getConnectionString: (this: void, langserverId: string) => Promise<string>;
  /**
   * Provide language association (language id, language server id) for a file with the uri.
   */
  getLanguageAssociation: (
    this: void,
    uri: string
  ) => LanguageAssociation | null;
  /**
   * Function to render Markdown to HTML string.
   * If not provided and the server's response contains Markdown, it'll be displayed as is.
   */
  renderMarkdown?: (this: void, markdown: string) => string;
  // Called when jumping to different document.
  // showTextDocument?: (uri: string, line?: number, character?: number) => void;
  // Called on showMeessage notification
  // showMessage?: (message: string, level: "error" | "warning" | "info" | "log") => void;
  // Called on logMeessage notification
  // logMessage?: (message: string, level: "error" | "warning" | "info" | "log") => void;
}

/**
 * Workspace provides code intelligence to CodeMirror editors by managing
 * communications with Language Servers and adding event handlers.
 */
export class Workspace {
  // Map of `documentUri` to open editors in the workspace.
  // Used to find the editor to apply actions on event.
  private editors: { [uri: string]: Editor };
  // Map of Language Server ID to connection.
  private connections: { [id: string]: LspConnection };
  // Map of `documentUri` to document versions.
  private documentVersions: { [uri: string]: number };
  // Array of Disposers to remove event listeners.
  private subscriptionDisposers: WeakMap<Editor, Disposer[]>;
  // Function to get the language server's connection string when creating new connection.
  private getConnectionString: (langserverId: string) => Promise<string>;
  // Function to get the language association from the document uri.
  private getLanguageAssociation: (uri: string) => LanguageAssociation | null;
  // Function to get convert Markdown to HTML string.
  private renderMarkdown: (markdown: string) => string;
  private canHandleMarkdown: boolean;
  // The URI of the project root.
  private rootUri: string;

  /**
   * Create new workspace.
   * @param options
   */
  constructor(options: WorkspaceOptions) {
    this.editors = Object.create(null);
    this.connections = Object.create(null);
    this.documentVersions = Object.create(null);
    this.subscriptionDisposers = new WeakMap();
    this.rootUri =
      options.rootUri + (!options.rootUri.endsWith("/") ? "/" : "");
    this.getConnectionString = options.getConnectionString.bind(void 0);
    this.getLanguageAssociation = options.getLanguageAssociation.bind(void 0);
    this.canHandleMarkdown = typeof options.renderMarkdown === "function";
    const renderMarkdown = options.renderMarkdown || ((x: string) => x);
    this.renderMarkdown = renderMarkdown.bind(void 0);
  }

  /**
   * Dispose the workspace.
   * Close connections and remove references to editors.
   */
  dispose() {
    // TODO shutdown and exit all connections
  }

  /**
   * Open text document in the workspace to notify the Language Server and
   * enable code intelligence.
   * @param path - The file path relative to the project root.
   * @param editor - CodeMirror Editor instance.
   */
  async openTextDocument(path: string, editor: Editor) {
    const uri = this.getDocumentUri(path);
    const assoc = this.getLanguageAssociation(uri);
    if (!assoc) return;
    // TODO Allow connecting to multiple language servers
    const serverId = assoc.languageServerIds[0];
    if (!serverId) return;
    const conn = await this.connect(serverId);
    if (!conn) return;

    this.editors[uri] = editor;
    this.documentVersions[uri] = 0;
    const languageId = assoc.languageId;
    conn.textDocumentOpened({
      textDocument: {
        uri,
        languageId,
        text: editor.getValue(),
        version: ++this.documentVersions[uri],
      },
    });

    this.addEventHandlers(uri, editor, conn);
  }

  // TODO Clean up. Workspace should signal custom events for providers to react
  private addEventHandlers(uri: string, editor: Editor, conn: LspConnection) {
    const disposers: Disposer[] = [];
    const changeStream = piped(
      fromEditorEvent(editor, "changes"),
      debouncedBuffer(CHANGES_FRAME),
      map((buffered) => {
        const cm = buffered[0][0];
        // Send incremental contentChanges
        conn.textDocumentChanged({
          textDocument: {
            uri,
            version: ++this.documentVersions[uri],
          },
          contentChanges: conn.syncsIncrementally
            ? buffered.flatMap(([_, cs]) => cs.map(lspChange))
            : [{ text: cm.getValue() }],
        });

        // Only pass the editor and the last change object.
        const lastChanges = buffered[buffered.length - 1][1];
        return [cm, lastChanges[lastChanges.length - 1]] as const;
      }),
      filter(([cm, change]) => {
        // Text removed
        if (
          change.origin === "+delete" ||
          change.text.every((s) => s.length === 0)
        ) {
          hideCompletions(cm);
          removeSignatureHelp(cm);
          return false;
        }
        return true;
      })
    );
    disposers.push(
      changeStream(([cm, change]) => {
        const pos = cm.getCursor();
        const token = cm.getTokenAt(pos);
        if (token.type && /\b(?:variable|property|type)\b/.test(token.type)) {
          // TODO Show both completion and signature help
          removeSignatureHelp(cm);
          // TODO Make minimum characters configurable
          // if (token.string.length < 3) return;
          conn
            .getCompletion({
              textDocument: { uri },
              position: lspPosition(pos),
              // Completion triggered by typing an identifier or manual invocation.
              context: { triggerKind: CompletionTriggerKind.Invoked },
            })
            .then((items) => {
              if (!items) return;
              // CompletionList to CompletionItem[]
              if (!Array.isArray(items)) items = items.items;
              showInvokedCompletions(
                cm,
                items,
                [
                  { line: pos.line, ch: token.start },
                  { line: pos.line, ch: token.end },
                ],
                this.renderMarkdown
              );
            });
          return;
        }

        // List of characters to trigger completion other than identifiers.
        const completionTriggers = conn.completionTriggers;
        const triggerCharacter = change.text[change.text.length - 1];
        if (completionTriggers.includes(triggerCharacter)) {
          // TODO Show both completion and signature help
          removeSignatureHelp(cm);
          conn
            .getCompletion({
              textDocument: { uri },
              position: lspPosition(pos),
              // Triggered by a trigger character specified by the `triggerCharacters`.
              context: {
                triggerKind: CompletionTriggerKind.TriggerCharacter,
                triggerCharacter,
              },
            })
            .then((items) => {
              if (!items) return;
              // CompletionList to CompletionItem[]
              if (!Array.isArray(items)) items = items.items;
              showTriggeredCompletions(cm, items, pos, this.renderMarkdown);
            });
          return;
        }

        const signatureHelpTriggers = conn.signatureHelpTriggers;
        const signatureHelpRetriggers = conn.signatureHelpRetriggers;
        if (
          signatureHelpTriggers.includes(triggerCharacter) ||
          signatureHelpRetriggers.includes(triggerCharacter)
        ) {
          // TODO Show both completion and signature help
          hideCompletions(cm);
          removeSignatureHelp(cm);
          // const getActiveSignatureHelp = getActiveSignatureHelp(cm);
          conn
            .getSignatureHelp({
              textDocument: { uri },
              position: lspPosition(pos),
              context: {
                triggerKind: SignatureHelpTriggerKind.TriggerCharacter,
                triggerCharacter,
                // TODO Look into this
                isRetrigger: false,
                // activeSignatureHelp,
              },
            })
            .then((help) => {
              if (!help || help.signatures.length === 0) return;
              showSignatureHelp(cm, help, pos, this.renderMarkdown);
            });

          return;
        }

        hideCompletions(cm);
        removeSignatureHelp(cm);
      })
    );

    // Highlights identifiers matching the word under cursor
    const cursorActivityStream = piped(
      fromEditorEvent(editor, "cursorActivity"),
      debounce(100),
      map(([cm]) => [cm, cm.getCursor()] as const),
      filter(([cm, pos]) => {
        const token = cm.getTokenAt(pos);
        if (token.type === "variable" || token.type === "property") {
          return true;
        }
        removeHighlights(cm);
        return false;
      })
    );
    disposers.push(
      cursorActivityStream(([cm, pos]) => {
        conn
          .getDocumentHighlight({
            textDocument: { uri },
            position: lspPosition(pos),
          })
          .then((highlights) => {
            removeHighlights(cm);
            if (highlights) showHighlights(cm, highlights);
          });
      })
    );

    // Show hover information on mouseover
    const mouseoverStream = piped(
      fromDomEvent(editor.getWrapperElement(), "mouseover"),
      filter(() => hoverInfoEnabled(editor)),
      debounce(100),
      map((ev) => editor.coordsChar({ left: ev.pageX, top: ev.pageY }, "page")),
      // Ignore same position
      skipDuplicates((p1, p2) => {
        if (p1.line !== p2.line) return false;
        if (p1.ch === p2.ch) return true;

        const t1 = editor.getTokenAt(p1);
        const t2 = editor.getTokenAt(p2);
        return (
          t1.string === t2.string && t1.start === t2.start && t1.end === t2.end
        );
      })
    );
    disposers.push(
      mouseoverStream((pos) => {
        removeHoverInfo(editor);
        const token = editor.getTokenAt(pos);
        if (
          token.type === "comment" ||
          token.string.length === 0 ||
          token.type === null
        ) {
          return;
        }

        conn
          .getHoverInfo({
            textDocument: { uri },
            position: lspPosition(pos),
          })
          .then((hover) => {
            if (hover) {
              removeSignatureHelp(editor);
              showHoverInfo(editor, pos, hover, this.renderMarkdown);
            }
          });
      })
    );

    disposers.push(
      onEditorEvent(editor, "cmw:contextMenuOpened", ([cm]) => {
        disableHoverInfo(cm);
        hideCompletions(cm);
        removeSignatureHelp(cm);
      }),
      onEditorEvent(editor, "cmw:contextMenuClosed", ([cm]) => {
        enableHoverInfo(cm);
      })
    );

    const gotoDefinition = (cm: Editor, pos: Position) => {
      conn
        .getDefinition({
          textDocument: { uri },
          position: lspPosition(pos),
        })
        .then((location) => {
          if (location) gotoLocation(cm, uri, location);
        });
    };
    const gotoDeclaration = (cm: Editor, pos: Position) => {
      conn
        .getDeclaration({
          textDocument: { uri },
          position: lspPosition(pos),
        })
        .then((location) => {
          if (location) gotoLocation(cm, uri, location);
        });
    };
    const gotoTypeDefinition = (cm: Editor, pos: Position) => {
      conn
        .getTypeDefinition({
          textDocument: { uri },
          position: lspPosition(pos),
        })
        .then((location) => {
          if (location) gotoLocation(cm, uri, location);
        });
    };
    const gotoReferences = (cm: Editor, pos: Position) => {
      conn
        .getReferences({
          textDocument: { uri },
          position: lspPosition(pos),
          context: {
            includeDeclaration: true,
          },
        })
        .then((location) => {
          if (location) gotoLocation(cm, uri, location);
        });
    };
    const gotoImplementations = (cm: Editor, pos: Position) => {
      conn
        .getImplementation({
          textDocument: { uri },
          position: lspPosition(pos),
        })
        .then((location) => {
          if (location) gotoLocation(cm, uri, location);
        });
    };

    disposers.push(
      onEditorEvent(editor, "contextmenu", ([cm, e]) => {
        e.preventDefault();
        const pos = cm.coordsChar({ left: e.pageX, top: e.pageY }, "page");
        // TODO Disable items if the server doesn't support it.
        showContextMenu(cm, e.pageX, e.pageY, [
          [
            {
              label: "Go to Definition",
              handler: () => {
                gotoDefinition(cm, pos);
              },
            },
            {
              label: "Go to Type Definition",
              handler: () => {
                gotoTypeDefinition(cm, pos);
              },
            },
            {
              label: "Go to Implementations",
              handler: () => {
                gotoImplementations(cm, pos);
              },
            },
            {
              label: "Go to References",
              handler: () => {
                gotoReferences(cm, pos);
              },
            },
            {
              label: "Go to Symbol...",
              handler: () => {
                conn
                  .getDocumentSymbol({
                    textDocument: { uri },
                  })
                  .then((symbols) => {
                    if (symbols) showSymbolSelector(cm, uri, symbols);
                  });
              },
            },
          ],
          // TODO Handle Copy and Cut because we won't show the browser's context menu.
          // Paste requires explicit permission.
          [
            {
              label: "Copy",
            },
            {
              label: "Cut",
            },
          ],
        ]);
      })
    );

    // Add some keymaps for jumping to various locations.
    const keyMap = normalizeKeyMap({
      // TODO Make this configurable
      "Alt-G D": (cm: Editor) => {
        gotoDefinition(cm, cm.getCursor());
      },
      "Alt-G H": (cm: Editor) => {
        gotoDeclaration(cm, cm.getCursor());
      },
      "Alt-G T": (cm: Editor) => {
        gotoTypeDefinition(cm, cm.getCursor());
      },
      "Alt-G I": (cm: Editor) => {
        gotoImplementations(cm, cm.getCursor());
      },
      "Alt-G R": (cm: Editor) => {
        gotoReferences(cm, cm.getCursor());
      },
    });
    editor.addKeyMap(keyMap);
    disposers.push(() => {
      editor.removeKeyMap(keyMap);
    });

    this.subscriptionDisposers.set(editor, disposers);
  }

  /**
   * Close text document in the workspace to notify the Language Server and
   * remove everything added by the workspace.
   * @param path - The file path relative to the project root.
   */
  async closeTextDocument(path: string) {
    const uri = this.getDocumentUri(path);
    const assoc = this.getLanguageAssociation(uri);
    if (!assoc) return;
    const serverId = assoc.languageServerIds[0];
    if (!serverId) return;
    const conn = this.connections[serverId];
    if (!conn) return;

    const editor = this.editors[uri];
    delete this.editors[uri];
    delete this.documentVersions[uri];
    this.removeEventHandlers(editor);
    conn.textDocumentClosed({
      textDocument: { uri },
    });
  }

  /**
   * Notify the Language Server that the text document was saved.
   *
   * If connected to a WebSocket proxy with synchronization enabled,
   * the contents of the file will be written to disk.
   * @param path - The file path relative to the project root.
   */
  async saveTextDocument(path: string) {
    const uri = this.getDocumentUri(path);
    // TODO Support `willSave` with `reason` and `willSaveWaitUntil`
    const assoc = this.getLanguageAssociation(uri);
    if (!assoc) return;

    const serverId = assoc.languageServerIds[0];
    if (!serverId) return;

    const conn = this.connections[serverId];
    if (!conn) return;

    const editor = this.editors[uri];
    if (!editor) return;

    // TODO Find Language Server supporting these to test
    conn.textDocumentWillSave({
      textDocument: { uri },
      reason: TextDocumentSaveReason.Manual,
    });
    const edits = await conn.getEditsBeforeSave({
      textDocument: { uri },
      reason: TextDocumentSaveReason.Manual,
    });
    if (edits) {
      applyEdits(editor, edits, "beforeSave");
      await delay(CHANGES_FRAME * 1.5);
    }
    conn.textDocumentSaved({
      textDocument: { uri },
      text: editor.getValue(),
    });
  }

  private removeEventHandlers(editor: Editor) {
    const disposers = this.subscriptionDisposers.get(editor);
    if (disposers) {
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      this.subscriptionDisposers.delete(editor);
    }

    removeDiagnostics(editor);
    removeHoverInfo(editor);
    removeHighlights(editor);
    hideCompletions(editor);
    removeSignatureHelp(editor);
  }

  /**
   * Private method to connect to the language server if possible.
   * If existing connection exists, it'll be shared.
   *
   * @param serverId - ID of the language server.
   */
  private async connect(serverId: string): Promise<LspConnection | undefined> {
    const existing = this.connections[serverId];
    if (existing) return existing;

    const connectionString = await this.getConnectionString(serverId);
    if (!connectionString) return;

    // If we got some string that doesn't start with Web Socket protocol, assume
    // it's the worker's location.
    const messageConn = /^wss?:\/\//.test(connectionString)
      ? createWebSocketMessageConnection(new WebSocket(connectionString))
      : createWorkerMessageConnection(new Worker(connectionString));
    const conn = await messageConn.then(createLspConnection);
    this.connections[serverId] = conn;
    conn.onClose(() => {
      delete this.connections[serverId];
    });

    conn.listen();

    await conn.initialize({
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: true,
            willSave: true,
            willSaveWaitUntil: true,
            didSave: true,
          },
          completion: {
            dynamicRegistration: true,
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              // TODO Look into this. Commit character accepts the completion and then get inserted.
              commitCharactersSupport: false,
              documentationFormat: this.canHandleMarkdown
                ? ["markdown", "plaintext"]
                : ["plaintext"],
              deprecatedSupport: true,
              preselectSupport: true,
            },
            contextSupport: true,
          },
          hover: {
            dynamicRegistration: true,
            contentFormat: this.canHandleMarkdown
              ? ["markdown", "plaintext"]
              : ["plaintext"],
          },
          signatureHelp: {
            dynamicRegistration: true,
            signatureInformation: {
              documentationFormat: this.canHandleMarkdown
                ? ["markdown", "plaintext"]
                : ["plaintext"],
              parameterInformation: {
                labelOffsetSupport: true,
              },
              // activeParameterSupport: true,
            },
            contextSupport: true,
          },
          declaration: {
            dynamicRegistration: true,
            linkSupport: false,
          },
          definition: {
            dynamicRegistration: true,
            linkSupport: true,
          },
          typeDefinition: {
            dynamicRegistration: true,
            linkSupport: true,
          },
          implementation: {
            dynamicRegistration: true,
            linkSupport: true,
          },
          references: {
            dynamicRegistration: true,
          },
          documentHighlight: {
            dynamicRegistration: true,
          },
          documentSymbol: {
            dynamicRegistration: true,
            hierarchicalDocumentSymbolSupport: true,
          },
          // codeAction: {},
          // codeLens: {},
          // documentLink: {
          //   dynamicRegistration: true,
          //   tooltipSupport: false,
          // },
          // colorProvider: {},
          // formatting: {},
          // rangeFormatting: {},
          // onTypeFormatting: {},
          // rename: {},
          // foldingRange: {},
          // selectionRange: {},
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: {
              valueSet: [DiagnosticTag.Unnecessary, DiagnosticTag.Deprecated],
            },
          },
          moniker: {},
        },
        workspace: {
          didChangeConfiguration: {
            dynamicRegistration: true,
          },
        },
      },
      // clientInfo: { name: "codemirror-workspace" },
      initializationOptions: null,
      processId: null,
      rootUri: this.rootUri,
      workspaceFolders: null,
    });
    conn.initialized();
    // TODO Allow configuring Language Server
    // conn.configurationChanged({ settings: {} });

    // Add event handlers to pass payload to matching open editors.
    conn.onDiagnostics(({ uri, diagnostics }) => {
      const editor = this.editors[uri];
      if (editor) showDiagnostics(editor, diagnostics);
    });

    return conn;
  }

  private getDocumentUri(path: string) {
    return this.rootUri + path.replace(/^\/+/, "");
  }
}

// Renaming file should be done by:
// 1. Close
// 2. Delete
// 3. Create
// 4. Open
