import { Box, Static, Text, render, useAnimation, useApp, useInput, usePaste } from "ink";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { rememberInteractiveHistory, type InteractiveCliHistory } from "./config.js";

export interface InteractiveCliResult {
  status: "success" | "error" | "info";
  message: string;
  detail?: string;
}

export interface InteractiveCliProgress {
  kind: "status" | "tool-call" | "tool-result" | "browser" | "file";
  message: string;
  detail?: string;
}

export interface InteractiveCliRunOptions {
  signal: AbortSignal;
  onProgress(event: InteractiveCliProgress): void;
}

export interface InteractiveCliSession {
  id: string;
  currentUrl(): string;
  run(task: string, options: InteractiveCliRunOptions): Promise<InteractiveCliResult>;
  login(): Promise<InteractiveCliResult>;
  close(): Promise<void>;
}

export interface InteractiveCliActions {
  version: string;
  workingDirectory: string;
  history: InteractiveCliHistory;
  saveHistory(history: InteractiveCliHistory): Promise<void>;
  openSession(startUrl: string): Promise<InteractiveCliSession>;
}

interface TuiIo {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  error: NodeJS.WriteStream;
}

interface TranscriptTurn {
  id: number;
  role: "user" | "mosaik";
  text: string;
  detail?: string;
  status?: InteractiveCliResult["status"];
}

type Screen =
  | { kind: "start"; error?: string }
  | { kind: "opening"; url: string }
  | { kind: "chat" };

type InteractiveInput =
  | { kind: "task"; task: string }
  | { kind: "login" }
  | { kind: "new" }
  | { kind: "clear" }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "error"; message: string };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const COMMANDS = [
  { name: "/login", description: "Log in on the current page" },
  { name: "/new", description: "Close this run and start a new session" },
  { name: "/clear", description: "Clear this conversation" },
  { name: "/help", description: "Show interactive commands" },
  { name: "/quit", description: "Close the browser and exit" },
] as const;

export async function runInteractiveCli(
  actions: InteractiveCliActions,
  io: TuiIo = { input: process.stdin, output: process.stdout, error: process.stderr },
): Promise<number> {
  let activeSession: InteractiveCliSession | undefined;
  const instance = render(
    <MosaikApp actions={actions} onSessionChanged={(session) => (activeSession = session)} />,
    {
      stdin: io.input,
      stdout: io.output,
      stderr: io.error,
      alternateScreen: false,
      incrementalRendering: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "enabled", flags: ["disambiguateEscapeCodes"] },
    },
  );
  try {
    const result = await instance.waitUntilExit();
    return typeof result === "number" ? result : 0;
  } finally {
    await activeSession?.close();
  }
}

function MosaikApp({
  actions,
  onSessionChanged,
}: {
  actions: InteractiveCliActions;
  onSessionChanged(session: InteractiveCliSession | undefined): void;
}) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
  const [session, setSession] = useState<InteractiveCliSession>();
  const [currentUrl, setCurrentUrl] = useState<string>();
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [pending, setPending] = useState<string>();
  const [history, setHistory] = useState(actions.history);
  const historyRef = useRef(actions.history);
  const historyWrite = useRef(Promise.resolve());
  const nextTurnId = useRef(1);
  const activePrompt = useRef<AbortController | undefined>(undefined);

  const addTurn = useCallback((turn: Omit<TranscriptTurn, "id">) => {
    setTranscript((current) => [...current, { ...turn, id: nextTurnId.current++ }]);
  }, []);

  const rememberHistory = useCallback(
    (kind: keyof InteractiveCliHistory, value: string) => {
      const next = {
        ...historyRef.current,
        [kind]: rememberInteractiveHistory(historyRef.current[kind], value),
      };
      historyRef.current = next;
      setHistory(next);
      historyWrite.current = historyWrite.current
        .catch(() => {})
        .then(() => actions.saveHistory(next))
        .catch(() => {});
    },
    [actions],
  );

  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (activePrompt.current !== undefined) {
      setPending("Cancelling current prompt");
      activePrompt.current.abort("Prompt cancelled");
      return;
    }
    exit(130);
  });

  const openSession = useCallback(
    async (startUrl: string) => {
      setScreen({ kind: "opening", url: startUrl });
      try {
        const opened = await actions.openSession(startUrl);
        onSessionChanged(opened);
        setSession(opened);
        setCurrentUrl(opened.currentUrl());
        setTranscript([]);
        rememberHistory("urls", startUrl);
        setScreen({ kind: "chat" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setScreen({ kind: "start", error: message });
      }
    },
    [actions, onSessionChanged, rememberHistory],
  );

  const finishResult = useCallback(
    (result: InteractiveCliResult) => {
      addTurn({
        role: "mosaik",
        text: result.message,
        status: result.status,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      if (session !== undefined) setCurrentUrl(session.currentUrl());
      setPending(undefined);
    },
    [addTurn, session],
  );

  const runTask = useCallback(
    async (task: string) => {
      if (session === undefined || pending !== undefined) return;
      rememberHistory("prompts", task);
      addTurn({ role: "user", text: task });
      const controller = new AbortController();
      activePrompt.current = controller;
      setPending("Inspecting the current page");
      try {
        finishResult(
          await session.run(task, {
            signal: controller.signal,
            onProgress: (event) => {
              setPending(progressLabel(event));
              if (event.kind === "status") return;
              addTurn({
                role: "mosaik",
                text: event.message,
                status: "info",
                ...(event.detail === undefined ? {} : { detail: event.detail }),
              });
            },
          }),
        );
      } catch (error) {
        finishResult({
          status: isAbortError(error) ? "info" : "error",
          message: isAbortError(error)
            ? "Prompt cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
        });
      } finally {
        if (activePrompt.current === controller) activePrompt.current = undefined;
        setPending(undefined);
      }
    },
    [addTurn, finishResult, pending, rememberHistory, session],
  );

  const runLogin = useCallback(async () => {
    if (session === undefined || pending !== undefined) return;
    addTurn({ role: "user", text: "/login" });
    setPending("Logging in");
    try {
      await waitUntilRenderFlush();
      let result: InteractiveCliResult | undefined;
      await suspendTerminal(async () => {
        result = await session.login();
      });
      finishResult(result ?? { status: "success", message: "Login completed" });
    } catch (error) {
      finishResult({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [addTurn, finishResult, pending, session, suspendTerminal, waitUntilRenderFlush]);

  const startNewSession = useCallback(async () => {
    if (session === undefined || pending !== undefined) return;
    setPending("Closing this run");
    try {
      await session.close();
      onSessionChanged(undefined);
      setSession(undefined);
      setCurrentUrl(undefined);
      setTranscript([]);
      setScreen({ kind: "start" });
    } catch (error) {
      finishResult({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(undefined);
    }
  }, [finishResult, onSessionChanged, pending, session]);

  const submitInteractiveInput = useCallback(
    (value: string) => {
      const parsed = parseInteractiveInput(value);
      switch (parsed.kind) {
        case "task":
          void runTask(parsed.task);
          return;
        case "login":
          void runLogin();
          return;
        case "new":
          void startNewSession();
          return;
        case "clear":
          setTranscript([]);
          return;
        case "quit":
          exit(0);
          return;
        case "help":
          addTurn({
            role: "mosaik",
            text: "Interactive commands",
            status: "info",
            detail: COMMANDS.map((command) => `${command.name}  ${command.description}`).join("\n"),
          });
          return;
        case "error":
          addTurn({ role: "mosaik", text: parsed.message, status: "error" });
      }
    },
    [addTurn, exit, runLogin, runTask, startNewSession],
  );

  switch (screen.kind) {
    case "start":
      return (
        <StartScreen
          actions={actions}
          history={history.urls}
          {...(screen.error === undefined ? {} : { error: screen.error })}
          onSubmit={(url) => void openSession(url)}
        />
      );
    case "opening":
      return <OpeningScreen actions={actions} url={screen.url} />;
    case "chat":
      return (
        <ChatScreen
          actions={actions}
          currentUrl={currentUrl ?? "Browser open"}
          sessionId={session?.id ?? "unknown"}
          transcript={transcript}
          history={history.prompts}
          {...(pending === undefined ? {} : { pending })}
          onSubmit={submitInteractiveInput}
        />
      );
  }
}

function StartScreen({
  actions,
  history,
  error,
  onSubmit,
}: {
  actions: InteractiveCliActions;
  history: string[];
  error?: string;
  onSubmit(url: string): void;
}) {
  const [editor, setEditor] = useState<InputEditorState>({ value: "", cursor: 0 });
  const [validationError, setValidationError] = useState<string>();
  const historyCycle = useRef<HistoryCycleState | undefined>(undefined);
  const value = editor.value;

  const resetHistoryCycle = useCallback(() => {
    historyCycle.current = undefined;
  }, []);

  const append = useCallback(
    (text: string) => {
      const cleaned = cleanInput(text, false);
      if (cleaned.length === 0) return;
      resetHistoryCycle();
      setEditor((current) => insertAtCursor(current, cleaned));
      setValidationError(undefined);
    },
    [resetHistoryCycle],
  );

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow) {
      resetHistoryCycle();
      setEditor((current) => moveCursor(current, key.leftArrow ? "left" : "right"));
      return;
    }
    if (key.home || key.end) {
      resetHistoryCycle();
      setEditor((current) => moveCursor(current, key.home ? "home" : "end"));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const cycled = cycleInputHistory(
        history,
        value,
        key.downArrow ? "next" : "previous",
        historyCycle.current,
      );
      if (cycled !== undefined) {
        historyCycle.current = cycled.state;
        setEditor(editorAtEnd(cycled.value));
        setValidationError(undefined);
      }
      return;
    }
    if (key.return) {
      const url = value.trim();
      const problem = validateWebUrl(url.length === 0 ? undefined : url);
      if (problem !== undefined) setValidationError(problem);
      else onSubmit(url);
      return;
    }
    if (key.backspace) {
      resetHistoryCycle();
      setEditor((current) => removeBeforeCursor(current));
      setValidationError(undefined);
      return;
    }
    if (key.delete) {
      resetHistoryCycle();
      setEditor((current) => removeAtCursor(current));
      setValidationError(undefined);
      return;
    }
    if (key.ctrl && input === "u") {
      resetHistoryCycle();
      setEditor({ value: "", cursor: 0 });
      setValidationError(undefined);
      return;
    }
    if (!key.ctrl && !key.meta && !key.super) append(input);
  });
  usePaste(append);

  return (
    <StartView
      version={actions.version}
      workingDirectory={actions.workingDirectory}
      value={value}
      cursor={editor.cursor}
      {...(validationError === undefined && error === undefined
        ? {}
        : { error: validationError ?? error })}
    />
  );
}

export function StartView({
  version,
  workingDirectory,
  value,
  cursor = inputLength(value),
  error,
}: {
  version: string;
  workingDirectory: string;
  value: string;
  cursor?: number;
  error?: string | undefined;
}) {
  return (
    <Frame actions={{ version, workingDirectory }}>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Where should we start?</Text>
        <Text dimColor>Enter a URL. Mosaik opens the browser immediately.</Text>
        <Box marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <EditableLine value={value} cursor={cursor} />
        </Box>
        {error === undefined ? null : (
          <Box marginTop={1}>
            <Text color="red">× {error}</Text>
          </Box>
        )}
      </Box>
      <Footer>enter open browser · ←/→ cursor · ↑/↓ history · ctrl+u clear · ctrl+c quit</Footer>
    </Frame>
  );
}

function OpeningScreen({ actions, url }: { actions: InteractiveCliActions; url: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return (
    <Frame actions={actions}>
      <Box marginTop={1}>
        <Text color="cyan">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} </Text>
        <Text>Opening {url}</Text>
      </Box>
    </Frame>
  );
}

function ChatScreen({
  actions,
  currentUrl,
  sessionId,
  transcript,
  history,
  pending,
  onSubmit,
}: {
  actions: InteractiveCliActions;
  currentUrl: string;
  sessionId: string;
  transcript: TranscriptTurn[];
  history: string[];
  pending?: string;
  onSubmit(value: string): void;
}) {
  return (
    <Frame actions={actions} currentUrl={currentUrl}>
      <Box flexDirection="column" marginTop={1}>
        {transcript.length === 0 ? (
          <Box flexDirection="column">
            <Text>What should I do in the browser?</Text>
            <Text dimColor>You can send more prompts after each task.</Text>
          </Box>
        ) : null}
        <Static items={transcript}>{(turn) => <TranscriptRow key={turn.id} turn={turn} />}</Static>
        {pending === undefined ? null : <PendingRow label={pending} />}
      </Box>
      <ChatInput
        active={pending === undefined}
        sessionId={sessionId}
        history={history}
        onSubmit={onSubmit}
      />
    </Frame>
  );
}

function TranscriptRow({ turn }: { turn: TranscriptTurn }) {
  if (turn.role === "user") {
    return (
      <Box marginTop={1}>
        <Text color="cyan">{"> "}</Text>
        <Text>{turn.text}</Text>
      </Box>
    );
  }
  const marker = turn.status === "error" ? "×" : turn.status === "success" ? "✓" : "·";
  const color = turn.status === "error" ? "red" : turn.status === "success" ? "green" : "cyan";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={color}>{marker} </Text>
        <Text>{turn.text}</Text>
      </Box>
      {turn.detail === undefined ? null : (
        <Box marginLeft={2}>
          <Text dimColor>{turn.detail}</Text>
        </Box>
      )}
    </Box>
  );
}

function PendingRow({ label }: { label: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return (
    <Box marginTop={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} </Text>
      <Text>{label}</Text>
    </Box>
  );
}

function ChatInput({
  active,
  sessionId,
  history,
  onSubmit,
}: {
  active: boolean;
  sessionId: string;
  history: string[];
  onSubmit(value: string): void;
}) {
  const [editor, setEditor] = useState<InputEditorState>({ value: "", cursor: 0 });
  const [selectedCommand, setSelectedCommand] = useState<string>();
  const commandCycle = useRef<CommandCycleState | undefined>(undefined);
  const historyCycle = useRef<HistoryCycleState | undefined>(undefined);
  const value = editor.value;
  const resetCommandCycle = useCallback(() => {
    commandCycle.current = undefined;
    setSelectedCommand(undefined);
  }, []);
  const resetHistoryCycle = useCallback(() => {
    historyCycle.current = undefined;
  }, []);
  const append = useCallback(
    (text: string) => {
      const cleaned = cleanInput(text, true);
      if (cleaned.length > 0) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor((current) => insertAtCursor(current, cleaned));
      }
    },
    [resetCommandCycle, resetHistoryCycle],
  );

  useInput(
    (input, key) => {
      if (key.leftArrow || key.rightArrow) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor((current) => moveCursor(current, key.leftArrow ? "left" : "right"));
        return;
      }
      if (key.home || key.end) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor((current) => moveCursor(current, key.home ? "home" : "end"));
        return;
      }
      if ((key.upArrow || key.downArrow) && value.startsWith("/") && !value.includes("\n")) {
        const cycled = cycleSlashCommand(
          value,
          key.downArrow ? "next" : "previous",
          commandCycle.current,
        );
        if (cycled !== undefined) {
          commandCycle.current = cycled.state;
          setSelectedCommand(cycled.value);
          setEditor(editorAtEnd(cycled.value));
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        resetCommandCycle();
        if (value.includes("\n")) {
          const cursor = moveCursorVertically(value, editor.cursor, key.upArrow ? "up" : "down");
          if (cursor !== undefined) setEditor((current) => ({ ...current, cursor }));
          return;
        }
        const cycled = cycleInputHistory(
          history,
          value,
          key.downArrow ? "next" : "previous",
          historyCycle.current,
        );
        if (cycled !== undefined) {
          historyCycle.current = cycled.state;
          setEditor(editorAtEnd(cycled.value));
        }
        return;
      }
      if (isMultilineInput(input, key)) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor((current) => insertAtCursor(current, "\n"));
        return;
      }
      if (key.return) {
        const submitted = value.trim();
        if (submitted.length === 0) return;
        resetCommandCycle();
        resetHistoryCycle();
        setEditor({ value: "", cursor: 0 });
        onSubmit(submitted);
        return;
      }
      if (key.escape) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor({ value: "", cursor: 0 });
        return;
      }
      if (key.backspace) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor((current) => removeBeforeCursor(current));
        return;
      }
      if (key.delete) {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor((current) => removeAtCursor(current));
        return;
      }
      if (key.ctrl && input === "u") {
        resetCommandCycle();
        resetHistoryCycle();
        setEditor({ value: "", cursor: 0 });
        return;
      }
      if (!key.ctrl && !key.meta && !key.super) append(input);
    },
    { isActive: active },
  );
  usePaste(append, { isActive: active });

  const lines = editableLines(value, editor.cursor);
  const showCommands = value.startsWith("/") && !value.includes("\n");
  return (
    <Box flexDirection="column" marginTop={1}>
      {active ? (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            <Box key={index}>
              <Text color="cyan">{index === 0 ? "> " : "  "}</Text>
              {line.cursor === undefined ? (
                <Text>{line.text}</Text>
              ) : (
                <>
                  <Text>{line.before}</Text>
                  <Cursor character={line.cursor} />
                  <Text>{line.after}</Text>
                </>
              )}
            </Box>
          ))}
        </Box>
      ) : null}
      {showCommands ? (
        <CommandSuggestions
          input={commandCycle.current?.query ?? value}
          {...(selectedCommand === undefined ? {} : { selected: selectedCommand })}
        />
      ) : null}
      <Footer>{sessionFooter(sessionId, active)}</Footer>
    </Box>
  );
}

function CommandSuggestions({ input, selected }: { input: string; selected?: string }) {
  const query = input.trim().toLowerCase();
  const commands = COMMANDS.filter((command) => command.name.startsWith(query));
  if (commands.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      {commands.map((command) => (
        <Box key={command.name}>
          <Box width={12}>
            <Text color="cyan">{selected === command.name ? "› " : "  "}</Text>
            <Text color="cyan" bold={selected === command.name}>
              {command.name}
            </Text>
          </Box>
          <Text dimColor>{command.description}</Text>
        </Box>
      ))}
    </Box>
  );
}

function Frame({
  actions,
  currentUrl,
  children,
}: {
  actions: Pick<InteractiveCliActions, "version" | "workingDirectory">;
  currentUrl?: string;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="cyan" bold>
          MOSAIK
        </Text>
        <Text dimColor> {actions.version}</Text>
      </Box>
      <Text dimColor>{currentUrl ?? actions.workingDirectory}</Text>
      {children}
    </Box>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{children}</Text>
    </Box>
  );
}

function EditableLine({ value, cursor }: { value: string; cursor: number }) {
  const [line] = editableLines(value, cursor);
  if (line === undefined || line.cursor === undefined) return <Text>{value}</Text>;
  return (
    <>
      <Text>{line.before}</Text>
      <Cursor character={line.cursor} />
      <Text>{line.after}</Text>
    </>
  );
}

function Cursor({ character = " " }: { character?: string }) {
  return (
    <Text color="black" backgroundColor="cyan">
      {character}
    </Text>
  );
}

export function parseInteractiveInput(value: string): InteractiveInput {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "login") return { kind: "login" };
  if (!trimmed.startsWith("/")) return { kind: "task", task: trimmed };
  const [command, ...args] = trimmed.split(/\s+/);
  if (args.length > 0) return { kind: "error", message: `${command} does not take arguments` };
  switch (command?.toLowerCase()) {
    case "/login":
      return { kind: "login" };
    case "/new":
      return { kind: "new" };
    case "/clear":
      return { kind: "clear" };
    case "/quit":
      return { kind: "quit" };
    case "/help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `Unknown command ${command}. Type /help for commands.` };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function progressLabel(event: InteractiveCliProgress): string {
  switch (event.kind) {
    case "tool-call":
      return `Calling ${event.message}`;
    case "tool-result":
      return `Received ${event.message} output`;
    default:
      return event.message;
  }
}

export function enterBehavior(shift: boolean): "newline" | "submit" {
  return shift ? "newline" : "submit";
}

export function isMultilineInput(input: string, key: { return: boolean; shift: boolean }): boolean {
  return (key.return && key.shift) || (key.shift && input === "\\");
}

export interface CommandCycleState {
  query: string;
  index: number;
}

export interface HistoryCycleState {
  index: number;
  draft: string;
}

export function cycleInputHistory(
  entries: string[],
  current: string,
  direction: "next" | "previous",
  previous?: HistoryCycleState,
): { value: string; state: HistoryCycleState } | undefined {
  if (entries.length === 0) return undefined;
  const state = previous ?? { index: entries.length, draft: current };
  const index =
    direction === "previous"
      ? Math.max(0, state.index - 1)
      : Math.min(entries.length, state.index + 1);
  return {
    value: index === entries.length ? state.draft : entries[index]!,
    state: { index, draft: state.draft },
  };
}

export function cycleSlashCommand(
  input: string,
  direction: "next" | "previous",
  previous?: CommandCycleState,
): { value: string; state: CommandCycleState } | undefined {
  if (!input.startsWith("/") || input.includes("\n")) return undefined;
  const query = previous?.query ?? input.trim().toLowerCase();
  const matches = COMMANDS.filter((command) => command.name.startsWith(query));
  if (matches.length === 0) return undefined;
  const offset = direction === "next" ? 1 : -1;
  const index =
    previous === undefined
      ? direction === "next"
        ? 0
        : matches.length - 1
      : (previous.index + offset + matches.length) % matches.length;
  return { value: matches[index]!.name, state: { query, index } };
}

export function sessionFooter(sessionId: string, active: boolean): string {
  return `session ${sessionId} · ${
    active
      ? "enter send · shift+enter newline · arrows navigate · ↑/↓ history or / commands · ctrl+c quit"
      : "ctrl+c cancel current prompt"
  }`;
}

export function validateWebUrl(value: string | undefined): string | undefined {
  if (value === undefined) return "Enter a start URL";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a complete URL, for example https://example.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "The URL must start with http:// or https://";
  }
  return undefined;
}

function cleanInput(value: string, multiline: boolean): string {
  return Array.from(value)
    .flatMap((character) => {
      if (multiline && character === "\n") return [character];
      if (character === "\t") return ["  "];
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127 ? [character] : [];
    })
    .join("");
}

export interface InputEditorState {
  value: string;
  cursor: number;
}

export function insertAtCursor(state: InputEditorState, inserted: string): InputEditorState {
  const characters = Array.from(state.value);
  const cursor = clampCursor(state.cursor, characters.length);
  const addition = Array.from(inserted);
  characters.splice(cursor, 0, ...addition);
  return { value: characters.join(""), cursor: cursor + addition.length };
}

export function removeBeforeCursor(state: InputEditorState): InputEditorState {
  const characters = Array.from(state.value);
  const cursor = clampCursor(state.cursor, characters.length);
  if (cursor === 0) return { value: state.value, cursor };
  characters.splice(cursor - 1, 1);
  return { value: characters.join(""), cursor: cursor - 1 };
}

export function removeAtCursor(state: InputEditorState): InputEditorState {
  const characters = Array.from(state.value);
  const cursor = clampCursor(state.cursor, characters.length);
  if (cursor === characters.length) return { value: state.value, cursor };
  characters.splice(cursor, 1);
  return { value: characters.join(""), cursor };
}

export function moveCursor(
  state: InputEditorState,
  direction: "left" | "right" | "home" | "end",
): InputEditorState {
  const length = inputLength(state.value);
  const cursor = clampCursor(state.cursor, length);
  switch (direction) {
    case "left":
      return { ...state, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { ...state, cursor: Math.min(length, cursor + 1) };
    case "home":
      return { ...state, cursor: lineBoundary(state.value, cursor, "start") };
    case "end":
      return { ...state, cursor: lineBoundary(state.value, cursor, "end") };
  }
}

export function moveCursorVertically(
  value: string,
  cursor: number,
  direction: "up" | "down",
): number | undefined {
  const lines = lineMetrics(value);
  const position = cursorPosition(lines, clampCursor(cursor, inputLength(value)));
  const targetLine = direction === "up" ? position.line - 1 : position.line + 1;
  const target = lines[targetLine];
  if (target === undefined) return undefined;
  return target.start + Math.min(position.column, target.length);
}

function editorAtEnd(value: string): InputEditorState {
  return { value, cursor: inputLength(value) };
}

function inputLength(value: string): number {
  return Array.from(value).length;
}

function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(length, cursor));
}

function lineBoundary(value: string, cursor: number, edge: "start" | "end"): number {
  const lines = lineMetrics(value);
  const position = cursorPosition(lines, cursor);
  const line = lines[position.line]!;
  return edge === "start" ? line.start : line.start + line.length;
}

interface InputLineMetric {
  start: number;
  length: number;
  text: string;
}

function lineMetrics(value: string): InputLineMetric[] {
  const rows = value.split("\n");
  let start = 0;
  return rows.map((text) => {
    const length = inputLength(text);
    const row = { start, length, text };
    start += length + 1;
    return row;
  });
}

function cursorPosition(
  lines: InputLineMetric[],
  cursor: number,
): { line: number; column: number } {
  for (let line = 0; line < lines.length; line += 1) {
    const metric = lines[line]!;
    if (cursor <= metric.start + metric.length) {
      return { line, column: cursor - metric.start };
    }
  }
  const line = lines.length - 1;
  return { line, column: lines[line]!.length };
}

type EditableLine =
  | { text: string; cursor?: undefined }
  | { before: string; cursor: string; after: string; text?: undefined };

function editableLines(value: string, cursor: number): EditableLine[] {
  const metrics = lineMetrics(value);
  const position = cursorPosition(metrics, clampCursor(cursor, inputLength(value)));
  return metrics.map((line, index) => {
    if (index !== position.line) return { text: line.text };
    const characters = Array.from(line.text);
    return {
      before: characters.slice(0, position.column).join(""),
      cursor: characters[position.column] ?? " ",
      after: characters.slice(position.column + 1).join(""),
    };
  });
}
