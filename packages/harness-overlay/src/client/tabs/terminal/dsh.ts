import type { ComponentType } from "react";
import type { ITheme } from "@xterm/xterm";
import type { TerminalSettings } from "../../../terminal-settings-contract.ts";

export interface TerminalObservable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** The public DSH model; transport and process ownership remain in DSH. */
export interface DshTerminalModel {
  readonly id: string;
  readonly state: TerminalObservable<{
    readonly title?: string;
    readonly phase: string;
    readonly error?: string;
    readonly info?: { readonly state: string };
  }>;
}

export interface DshTerminalTab {
  readonly sessionId: string;
  readonly tabId: string;
  readonly contentId: string;
}

export interface DshTerminals {
  view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): DshTerminalModel;
  close(sessionId: string, key: string, contentId: string, terminalId?: string): void;
  /** Pinned shared-terminal-view patch adds independent retention owners. */
  retainTabs(tabs: readonly DshTerminalTab[], owner?: string): void;
}

/** One provider-owned screen, including recovery and application OSC colors. */
export interface DshTerminalUI {
  readonly View: ComponentType<{
    model: DshTerminalModel;
    visible: boolean;
    onNewTerminal(): void;
  }>;
  setAppearance(appearance: Partial<Pick<TerminalSettings, "lineHeight">> & { theme?: ITheme }): void;
}
