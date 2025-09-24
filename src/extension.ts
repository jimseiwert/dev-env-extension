import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "dev-env-helper" is now active!');

	let disposable = vscode.commands.registerCommand('dev-env-helper.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from Dev Environment Helper!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}