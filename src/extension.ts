import * as vscode from 'vscode';
import { ExtensionManager } from './managers';

let extensionManager: ExtensionManager;

export async function activate(context: vscode.ExtensionContext) {
  extensionManager = new ExtensionManager(context);
  await extensionManager.activate();
}

export function deactivate() {
  extensionManager?.dispose();
}