/// <reference types="codemirror/addon/hint/show-hint" />

import type { Editor, Position, Range, Hint, Hints } from "codemirror";
import type { CompletionItem } from "vscode-languageserver-protocol";
import CodeMirror from "codemirror";

import {
  documentationToString,
  completionItemKindToString,
} from "../utils/conversions";

/**
 * Show completion triggered by typing an identifier or manual invocation.
 * @param editor
 * @param items - Completion items from the server.
 * @param wordRange - Range describing the span of the typed identifier.
 */
export const showInvokedCompletions = (
  editor: Editor,
  items: CompletionItem[],
  wordRange: Range
) => {
  if (items.length === 0) return;

  const typed = editor.getRange(wordRange.from(), wordRange.to());
  const filtered = filteredItems(items, typed, 30);
  editor.showHint({
    completeSingle: false,
    hint: () =>
      withItemTooltip({
        from: wordRange.from(),
        to: wordRange.to(),
        // To handle more complex completions, we can provide `hint` function
        // to apply the completion ourselves as well.
        list: filtered.map((item) => ({
          // TODO Add from/to here to handle some edge cases.
          text: item.label,
          displayText: item.label,
          render: itemRenderer(item),
          data: getItemData(item),
        })),
      }),
  });
};

/**
 * Show completions triggered by a trigger character specified by the `triggerCharacters`.
 * Completion items are inserted differently from when it's invoked.
 * @param editor - The editor.
 * @param items - Completion items from the server.
 * @param cursorPosition - Current cursor position where the item will be inserted after.
 */
export const showTriggeredCompletions = (
  editor: Editor,
  items: CompletionItem[],
  cursorPosition: Position
) => {
  if (items.length === 0) return;

  editor.showHint({
    completeSingle: false,
    hint: () =>
      withItemTooltip({
        from: cursorPosition,
        to: cursorPosition,
        list: items.map((item) => ({
          text: item.label,
          displayText: item.label,
          render: itemRenderer(item),
          data: getItemData(item),
        })),
      }),
  });
};

/**
 * Hide completion popup.
 * @param editor
 */
export const hideCompletions = (editor: Editor) => {
  if (editor.state.completionActive) editor.state.completionActive.close();
};

interface HintData {
  kind: string;
  detail: string;
  documentation: string;
}

interface HintWithData extends Hint {
  data: HintData;
}

// Returns `hints` with an ability to show details of each completion item on `select`.
// See https://github.com/codemirror/CodeMirror/blob/6fcc49d5321261b525e50f111f3b28a602f01f71/addon/tern/tern.js#L229
const withItemTooltip = (hints: Hints): Hints => {
  let tooltip: HTMLElement | null = null;
  CodeMirror.on(hints, "close", () => {
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  });
  CodeMirror.on(hints, "update", () => {
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  });
  CodeMirror.on(hints, "select", (cur: HintWithData, node: HTMLElement) => {
    tooltip?.remove();
    const data = cur.data;
    if (!data) return;

    // TODO Generate content from attached data
    let content = `${data.kind}`;
    if (data.documentation) content += ` ${data.documentation}`;
    else content += ` ${cur.text}`;
    if (!content) return;

    const x =
      (node.parentNode! as HTMLElement).getBoundingClientRect().right +
      window.pageXOffset;
    const y = node.getBoundingClientRect().top + window.pageYOffset;
    const el = document.createElement("div");
    el.innerHTML = content;
    tooltip = document.createElement("div");
    tooltip.classList.add("cm-lsp-completion-item-doc");
    tooltip.style.position = "absolute";
    tooltip.style.zIndex = "10";
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.style.fontSize = "12px";
    tooltip.style.padding = "2px";

    tooltip.appendChild(el);
    document.body.appendChild(tooltip);
  });
  return hints;
};

const getItemData = (item: CompletionItem): HintData => ({
  kind: completionItemKindToString(item.kind),
  detail: item.detail || "",
  documentation: documentationToString(item.documentation),
});

// Returns a function to render `item` in completion popup.
const itemRenderer = (item: CompletionItem) => (el: HTMLElement) => {
  // TODO Use meaningful icons for each kind
  // TODO Show matching characters in different color?
  const hue = Math.floor(((item.kind || 0) / 30) * 180 + 180);
  const custom = document.createElement("div");
  custom.style.display = "flex";
  custom.style.alignItems = "center";
  custom.innerHTML = [
    `<span style="color: hsl(${hue}, 75%, 50%); font-size: 8px;">⬤</span>`,
    `<span style="margin-left: 4px">${item.label}</span>`,
  ].join("\n");
  el.append(custom);
};

const filteredItems = (
  items: CompletionItem[],
  typed: string,
  maxItems: number = 30
) => {
  const scores = items.reduce((o, item) => {
    o[item.label] = lcsScore(item.filterText || item.label, typed);
    // Boost the score if preselect
    // if (item.preselect) o[item.label] *= 100;
    return o;
  }, {} as { [k: string]: number });

  return items
    .slice()
    .sort((a, b) => scores[b.label] - scores[a.label])
    .slice(0, maxItems);
};

// Similarity score between strings based on the length of the longest common subsequence.
const lcsScore = (item: string, typed: string): number => {
  if (item.length === 0 || typed.length === 0) return 0;
  // Prefer shorter item if it includes typed word.
  if (item.includes(typed)) return typed.length + 1 / item.length;

  return item.length < typed.length ? lcs(typed, item) : lcs(item, typed);
};

// LCS with 2*min(m, n) space
// x.length >= y.length
const lcs = (x: string, y: string): number => {
  const m = x.length;
  const n = y.length;
  const zs = [0];
  for (let i = 0; i <= n; ++i) zs[i] = 0;
  const L = [zs, zs.slice()];
  let b = 0;
  for (let i = 0; i <= m; ++i) {
    b = i & 1;
    for (let j = 0; j <= n; ++j) {
      if (i === 0 || j === 0) {
        L[b][j] = 0;
      } else {
        L[b][j] =
          x[i - 1] === y[j - 1]
            ? L[b ^ 1][j - 1] + 1
            : Math.max(L[b ^ 1][j], L[b][j - 1]);
      }
    }
  }
  return L[b][n];
};
