import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";

const readFile = util.promisify(fs.readFile);

interface CSSVariable {
  name: string;
  value: string;
  comment?: string;
  file: string;
  line: number;
  type: "color" | "other";
}

const outputChannel = vscode.window.createOutputChannel(
  "CSS Variable Predictor"
);

function log(message: string) {
  console.log(message); // Also log to debug console
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
  let cssVariables: CSSVariable[] = [];
  let debounceTimer: NodeJS.Timeout;

  function getVariableType(name: string, value: string): CSSVariable["type"] {
    if (value.match(/(#[0-9a-f]{3,8}|rgb|hsl|rgba|hsla|linear-gradient)/i)) {
      return "color";
    }
    return "other";
  }
  async function extractCSSVariables(filePath: string): Promise<CSSVariable[]> {
    const content = await readFile(filePath, "utf-8");
    const variables: CSSVariable[] = [];

    // Regular expression to match the start of a CSS variable declaration
    const varStartRegex = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]*)/gm;

    let match;
    while ((match = varStartRegex.exec(content)) !== null) {
      const name = match[1];
      let value = match[2].trim();
      let comment;
      const startIndex = match.index;

      // If the value looks incomplete (e.g., has unmatched parentheses)
      if (countParentheses(value) > 0) {
        log(`Processing multi-line value for ${name}`);

        // Get the substring from the start of this variable declaration
        const remainingContent = content.slice(startIndex);
        log(`Initial value: ${value}`);

        // Find the closing semicolon and any following comment
        const endMatch = remainingContent.match(
          /^[^;]*;(?:\s*\/\*\s*(.+?)\s*\*\/)?/s
        );

        if (endMatch) {
          log(`Found end match: ${endMatch[0]}`);

          // Get everything between the colon and semicolon
          const fullValue = endMatch[0].slice(name.length + 1, -1); // +1 for the colon, -1 for the semicolon
          log(`Full value before processing: ${fullValue}`);

          // Clean up the value
          value = fullValue
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line)
            .join(" ")
            .trim();

          log(`Final processed value: ${value}`);

          // Extract comment if present
          comment = endMatch[1]?.trim();
        }
      } else {
        // For single-line declarations, check for inline comment
        const commentMatch = content
          .slice(startIndex)
          .match(/^[^;]*;(?:\s*\/\*\s*(.+?)\s*\*\/)?/);
        comment = commentMatch?.[1]?.trim();
      }

      const line = content.slice(0, startIndex).split("\n").length;

      if (value) {
        // Only add if we have a value
        variables.push({
          name,
          value,
          comment,
          file: filePath,
          line,
          type: getVariableType(name, value),
        });
      }
    }

    log(`Extracted ${variables.length} variables from ${filePath}`);
    return variables;
  }

  const provider = vscode.languages.registerCompletionItemProvider(
    [
      "css",
      "scss",
      "less",
      "html",
      "javascriptreact",
      "typescriptreact",
      "astro",
    ],
    {
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ) {
        const linePrefix = document
          .lineAt(position)
          .text.substr(0, position.character);

        if (!linePrefix.includes("var(")) {
          return undefined;
        }

        // Get variables from other files only
        const currentFilePath = document.uri.fsPath;
        const uniqueVariables = new Map<string, CSSVariable>();

        cssVariables
          .filter((variable) => {
            if (
              document.languageId === "css" ||
              document.languageId === "scss" ||
              document.languageId === "less"
            ) {
              return variable.file !== currentFilePath;
            }
            // For other file types, include all variables
            return true;
          })
          .forEach((variable) => {
            uniqueVariables.set(variable.name, variable);
          });

        log(
          `Filtered variables for ${currentFilePath}: ${uniqueVariables.size}`
        );

        const completionItems = Array.from(uniqueVariables.values()).map(
          (variable) => {
            const item = new vscode.CompletionItem(
              variable.name,
              variable.type === "color"
                ? vscode.CompletionItemKind.Color
                : vscode.CompletionItemKind.Value
            );
            log(
              `Creating completion item for ${variable.name} (${variable.type})`
            );

            item.insertText = variable.name;
            item.label = {
              label: variable.name,
              description: variable.value, // This should appear on the right
            };

            const docs = new vscode.MarkdownString();
            docs.appendCodeblock(variable.value, "css");

            if (variable.comment) {
              docs.appendText(`\n${variable.comment}`);
            }

            docs.appendText(
              `\n\nDefined in ${path.basename(variable.file)}:${variable.line}`
            );
            item.documentation = docs;
            item.sortText = `z-${variable.name}`;

            return item;
          }
        );

        log(`Returning ${completionItems.length} completion items`);
        return completionItems;
      },
    },
    "("
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{css,scss,less}"
  );

  const updateVariablesDebounced = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const variables: CSSVariable[] = [];
      if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
          const pattern = new vscode.RelativePattern(
            folder,
            "**/*.{css,scss,less}"
          );
          const files = await vscode.workspace.findFiles(pattern);

          log(`Found ${files.length} CSS files in workspace`);

          for (const file of files) {
            try {
              const vars = await extractCSSVariables(file.fsPath);
              variables.push(...vars);
              log(`Added ${vars.length} variables from ${file.fsPath}`);
            } catch (error) {
              log(`Error processing ${file.fsPath}: ${error}`);
            }
          }
        }
      }
      cssVariables = variables;
    }, 1000);
  };

  watcher.onDidChange(updateVariablesDebounced);
  watcher.onDidCreate(updateVariablesDebounced);
  watcher.onDidDelete(updateVariablesDebounced);

  // Initial scan
  updateVariablesDebounced();

  context.subscriptions.push(provider, watcher);
}

function countParentheses(str: string): number {
  let count = 0;
  for (const char of str) {
    if (char === "(") {
      count++;
    }
    if (char === ")") {
      count--;
    }
  }
  return count;
}

export function deactivate() {}
