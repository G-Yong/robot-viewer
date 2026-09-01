import type { HostToWebview, WebviewToHost } from "../src/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

export function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

export function getState<T = unknown>(): T | undefined {
  return vscode.getState() as T | undefined;
}

export function setState(state: unknown): void {
  vscode.setState(state);
}

export function onMessage(handler: (msg: HostToWebview) => void): void {
  window.addEventListener("message", (event) => handler(event.data as HostToWebview));
}

export function log(level: "info" | "warn" | "error", message: string): void {
  post({ type: "log", level, message });
}
