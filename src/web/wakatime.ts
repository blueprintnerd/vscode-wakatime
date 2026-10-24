import * as vscode from 'vscode';

import {
  AI_RECENT_PASTES_TIME_MS,
  COMMAND_DASHBOARD,
  HACKATIME_API_URL,
  Heartbeat,
  LogLevel,
  SEND_BUFFER_SECONDS,
} from '../constants';

import { Logger } from './logger';
import { Memento } from 'vscode';
import { FileSelectionMap, HumanTypingMap, LineCounts, LinesInFiles } from '../types';
import { Utils } from '../utils';

export class WakaTime {
  private agentName: string;
  private extension: any;
  private statusBar?: vscode.StatusBarItem = undefined;
  private statusBarTeamYou?: vscode.StatusBarItem = undefined;
  private statusBarTeamOther?: vscode.StatusBarItem = undefined;
  private disposable: vscode.Disposable;
  private lastFile: string;
  private lastHeartbeat: number = 0;
  private lastDebug: boolean = false;
  private lastCompile: boolean = false;
  private lastAICodeGenerating: boolean = false;
  private lastCodeReviewing: boolean = false;
  private dedupe: FileSelectionMap = {};
  private debounceId: any = null;
  private debounceMs = 50;
  private AIDebounceId: any = null;
  private AIdebounceMs = 1000;
  private AIdebounceCount = 0;
  private AIrecentPastes: number[] = [];
  private logger: Logger;
  private config: Memento;
  private fetchTodayInterval: number = 60000;
  private lastFetchToday: number = 0;
  private showStatusBar: boolean;
  private showStatusBarTeam: boolean;
  private hasTeamFeatures: boolean;
  private showCodingActivity: boolean;
  private disabled: boolean = true;
  private isCompiling: boolean = false;
  private isDebugging: boolean = false;
  private isAICodeGenerating: boolean = false;
  private hasAICapabilities: boolean = false;
  private currentlyFocusedFile: string;
  private teamDevsForFileCache = {};
  private lastApiKeyPrompted: number = 0;
  private heartbeats: Heartbeat[] = [];
  private lastSent: number = 0;
  private linesInFiles: LinesInFiles = {};
  private lineChanges: LineCounts = { ai: {}, human: {} };
  private filesWithHumanTyping: HumanTypingMap = {};

  constructor(logger: Logger, config: Memento) {
    this.logger = logger;
    this.config = config;
  }

  public initialize(): void {
    if (this.config.get('wakatime.debug') == 'true') {
      this.logger.setLevel(LogLevel.DEBUG);
    }

    const extension = vscode.extensions.getExtension('WakaTime.vscode-wakatime');
    this.extension = (extension != undefined && extension.packageJSON) || { version: '0.0.0' };
    this.agentName = Utils.getEditorName();

    this.hasAICapabilities = Utils.hasAIExtensions();

    this.disabled = this.config.get('wakatime.disabled') === 'true';
    if (this.disabled) {
      this.dispose();
      return;
    }

    this.initializeDependencies();
  }

  public dispose() {
    this.sendHeartbeats();
    this.statusBar?.dispose();
    this.statusBarTeamYou?.dispose();
    this.statusBarTeamOther?.dispose();
    this.disposable?.dispose();
  }

  public initializeDependencies(): void {
    this.logger.debug(`Initializing WakaTime v${this.extension.version}`);

    const align = this.getStatusBarAlignment();
    const priority = this.getStatusBarPriority();

    this.statusBar = vscode.window.createStatusBarItem(
      'com.wakatime.statusbar',
      align,
      priority + 2,
    );
    this.statusBar.name = 'WakaTime';
    this.statusBar.command = COMMAND_DASHBOARD;

    this.statusBarTeamYou = vscode.window.createStatusBarItem(
      'com.wakatime.teamyou',
      align,
      priority + 1,
    );
    this.statusBarTeamYou.name = 'WakaTime Top dev';

    this.statusBarTeamOther = vscode.window.createStatusBarItem(
      'com.wakatime.teamother',
      align,
      priority,
    );
    this.statusBarTeamOther.name = 'WakaTime Team Total';

    const showStatusBar = this.config.get('wakatime.status_bar_enabled');
    this.showStatusBar = showStatusBar !== 'false';

    const showStatusBarTeam = this.config.get('wakatime.status_bar_team');
    this.showStatusBarTeam = showStatusBarTeam !== 'false';

    this.setStatusBarVisibility(this.showStatusBar);
    this.updateStatusBarText('WakaTime Initializing...');

    this.loadOfflineQueue();
    try {
      if (typeof addEventListener === 'function') {
        addEventListener('online', () => {
          this.sendHeartbeats();
        });
      }
    } catch (_) {}

    this.checkApiKey();

    this.setupEventListeners();

    this.logger.debug('WakaTime initialized.');

    const showCodingActivity = this.config.get('wakatime.status_bar_coding_activity');
    this.showCodingActivity = showCodingActivity !== 'false';

    this.updateStatusBarText();
    this.updateStatusBarTooltip('WakaTime: Initialized');
    this.getCodingActivity();
  }

  private updateStatusBarText(text?: string): void {
    if (!this.statusBar) return;
    if (!text) {
      this.statusBar.text = '$(clock)';
    } else {
      this.statusBar.text = '$(clock) ' + text;
    }
  }

  private updateStatusBarTooltip(tooltipText: string): void {
    if (!this.statusBar) return;
    this.statusBar.tooltip = tooltipText;
  }

  private updateTeamStatusBarTextForCurrentUser(text?: string): void {
    if (!this.statusBarTeamYou) return;
    if (!text) {
      this.statusBarTeamYou.text = '';
    } else {
      this.statusBarTeamYou.text = text;
    }
  }

  private updateStatusBarTooltipForCurrentUser(tooltipText: string): void {
    if (!this.statusBarTeamYou) return;
    this.statusBarTeamYou.tooltip = tooltipText;
  }

  private updateTeamStatusBarTextForOther(text?: string): void {
    if (!this.statusBarTeamOther) return;
    if (!text) {
      this.statusBarTeamOther.text = '';
    } else {
      this.statusBarTeamOther.text = text;
    }
  }

  private updateStatusBarTooltipForOther(tooltipText: string): void {
    if (!this.statusBarTeamOther) return;
    this.statusBarTeamOther.tooltip = tooltipText;
  }

  private statusBarShowingError(): boolean {
    if (!this.statusBar) return false;
    return this.statusBar.text.indexOf('Error') != -1;
  }

  public promptForApiKey(hidden: boolean = true): void {
    let defaultVal: string = this.getApiKey() || '';
    if (Utils.apiKeyInvalid(defaultVal)) defaultVal = '';
    const promptOptions = {
      prompt: 'Hackatime v2 Api Key',
      placeHolder: 'Enter your API key from https://hackatime.hackclub.com',
      value: defaultVal,
      ignoreFocusOut: true,
      password: hidden,
      validateInput: Utils.apiKeyInvalid.bind(this),
    };
    vscode.window.showInputBox(promptOptions).then(async (val) => {
      if (val != undefined) {
        const trimmed = val.trim();
        const invalid = Utils.apiKeyInvalid(trimmed);
        if (!invalid) {
          await this.config.update('wakatime.apiKey', trimmed);
          await this.saveOrbitConfigFile(trimmed);
          this.getCodingActivity();
        } else vscode.window.setStatusBarMessage(invalid);
      } else vscode.window.setStatusBarMessage('Hackatime api key not provided');
    });
  }

  public promptForApiUrl(): void {
    vscode.window.showInformationMessage(
      `Locked to Hackatime v2 (${HACKATIME_API_URL})`,
    );
  }

  public promptForDebug(): void {
    let defaultVal: string = this.config.get('wakatime.debug') || '';
    if (!defaultVal || defaultVal !== 'true') defaultVal = 'false';
    const items: string[] = ['true', 'false'];
    const promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal == null) return;
      this.config.update('wakatime.debug', newVal);
      if (newVal === 'true') {
        this.logger.setLevel(LogLevel.DEBUG);
        this.logger.debug('Debug enabled');
      } else {
        this.logger.setLevel(LogLevel.INFO);
      }
    });
  }

  public promptToDisable(): void {
    const previousValue = this.disabled;
    let currentVal = this.config.get('wakatime.disabled');
    if (!currentVal || currentVal !== 'true') currentVal = 'false';
    const items: string[] = ['disable', 'enable'];
    const helperText = currentVal === 'true' ? 'disabled' : 'enabled';
    const promptOptions = {
      placeHolder: `disable or enable (extension is currently "${helperText}")`,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal !== 'enable' && newVal !== 'disable') return;
      this.disabled = newVal === 'disable';
      if (this.disabled != previousValue) {
        if (this.disabled) {
          this.config.update('wakatime.disabled', 'true');
          this.logger.debug('Extension disabled, will not report code stats to dashboard');
          this.dispose();
        } else {
          this.config.update('wakatime.disabled', 'false');
          this.initializeDependencies();
        }
      }
    });
  }

  public promptStatusBarIcon(): void {
    let defaultVal: string = this.config.get('wakatime.status_bar_enabled') || '';
    if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
    const items: string[] = ['true', 'false'];
    const promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal !== 'true' && newVal !== 'false') return;
      this.config.update('wakatime.status_bar_enabled', newVal);
      this.showStatusBar = newVal === 'true'; // cache setting to prevent reading from disc too often
      this.setStatusBarVisibility(this.showStatusBar);
    });
  }

  public promptStatusBarCodingActivity(): void {
    let defaultVal: string = this.config.get('wakatime.status_bar_coding_activity') || '';
    if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
    const items: string[] = ['true', 'false'];
    const promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal !== 'true' && newVal !== 'false') return;
      this.config.update('wakatime.status_bar_coding_activity', newVal);
      if (newVal === 'true') {
        this.logger.debug('Coding activity in status bar has been enabled');
        this.showCodingActivity = true;
        this.getCodingActivity();
      } else {
        this.logger.debug('Coding activity in status bar has been disabled');
        this.showCodingActivity = false;
        if (!this.statusBarShowingError()) {
          this.updateStatusBarText();
        }
      }
    });
  }

  public openDashboardWebsite(): void {
    const apiUrl = this.getApiUrl();
    const dashboardUrl = Utils.apiUrlToDashboardUrl(apiUrl);
    vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
  }

  private checkApiKey(): void {
    this.loadOrbitConfigFile().then(() => {
      this.hasApiKey((hasApiKey) => {
        if (!hasApiKey) this.promptForApiKey();
        else this.getCodingActivity();
      });
    });
  }

  private getApiKey(): string {
    return (
      (this.config.get('wakatime.apiKey') as string) ||
      (vscode.workspace.getConfiguration().get('wakatime.apiKey') as string) ||
      ''
    );
  }

  private async loadOrbitConfigFile(): Promise<void> {
    if (!Utils.apiKeyInvalid(this.getApiKey())) return;
    try {
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (!wsf || wsf.uri.scheme !== 'orbit') return;
      const cfgUri = vscode.Uri.joinPath(wsf.uri, '.wakatime.cfg');
      const raw = await vscode.workspace.fs.readFile(cfgUri);
      const text = new TextDecoder().decode(raw);
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*api_key\s*=\s*(.+?)\s*$/);
        if (m && !Utils.apiKeyInvalid(m[1])) {
          await this.config.update('wakatime.apiKey', m[1].trim());
          return;
        }
      }
    } catch (_) {}
  }

  private async saveOrbitConfigFile(apiKey: string): Promise<void> {
    try {
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (!wsf || wsf.uri.scheme !== 'orbit') return;
      const cfgUri = vscode.Uri.joinPath(wsf.uri, '.wakatime.cfg');
      const content = `[settings]\napi_url = ${HACKATIME_API_URL}\napi_key = ${apiKey}\n`;
      await vscode.workspace.fs.writeFile(cfgUri, new TextEncoder().encode(content));
    } catch (_) {}
  }

  private hasApiKey(callback: (arg0: boolean) => void): void {
    const apiKey: string = this.getApiKey();
    callback(!Utils.apiKeyInvalid(apiKey));
  }

  private getStatusBarAlignment(): vscode.StatusBarAlignment {
    const align: string = this.config.get('wakatime.align') ?? '';
    switch (align) {
      case 'left':
        return vscode.StatusBarAlignment.Left;
      case 'right':
        return vscode.StatusBarAlignment.Right;
      default:
        return vscode.StatusBarAlignment.Left;
    }
  }

  private getStatusBarPriority(): number {
    const priority = this.config.get('wakatime.alignPriority');
    return typeof priority === 'number' ? priority : 1;
  }

  private setStatusBarVisibility(isVisible: boolean): void {
    if (isVisible) {
      this.statusBar?.show();
      this.statusBarTeamYou?.show();
      this.statusBarTeamOther?.show();
      this.logger.debug('Status bar icon enabled.');
    } else {
      this.statusBar?.hide();
      this.statusBarTeamYou?.hide();
      this.statusBarTeamOther?.hide();
      this.logger.debug('Status bar icon disabled.');
    }
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    const subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeTextEditorSelection(this.onChangeSelection, this, subscriptions);
    vscode.workspace.onDidChangeTextDocument(this.onChangeTextDocument, this, subscriptions);
    vscode.window.onDidChangeActiveTextEditor(this.onChangeTab, this, subscriptions);
    vscode.window.tabGroups.onDidChangeTabs(this.onDidChangeTabs, this, subscriptions);
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions);

    vscode.workspace.onDidChangeNotebookDocument(this.onChangeNotebook, this, subscriptions);
    vscode.workspace.onDidSaveNotebookDocument(this.onSaveNotebook, this, subscriptions);

    vscode.tasks.onDidStartTask(this.onDidStartTask, this, subscriptions);
    vscode.tasks.onDidEndTask(this.onDidEndTask, this, subscriptions);

    vscode.debug.onDidChangeActiveDebugSession(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidChangeBreakpoints(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession, this, subscriptions);
    vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession, this, subscriptions);

    // create a combined disposable for all event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private onDebuggingChanged(): void {
    this.logger.debug('onDebuggingChanged');
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidStartDebugSession(): void {
    this.logger.debug('onDidStartDebugSession');
    this.isDebugging = true;
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidTerminateDebugSession(): void {
    this.logger.debug('onDidTerminateDebugSession');
    this.isDebugging = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidStartTask(e: vscode.TaskStartEvent): void {
    this.logger.debug('onDidStartTask');
    if (e.execution.task.isBackground) return;
    if (e.execution.task.detail && e.execution.task.detail.indexOf('watch') !== -1) return;
    this.isCompiling = true;
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidEndTask(): void {
    this.logger.debug('onDidEndTask');
    this.isCompiling = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onChangeSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    this.logger.debug('onChangeSelection');
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onChangeTextDocument(e: vscode.TextDocumentChangeEvent): void {
    this.logger.debug('onChangeTextDocument');

    if (e.contentChanges.find((v) => v.text.length === 1)) {
      const file = Utils.getFocusedFile(e.document);
      if (file) {
        this.filesWithHumanTyping[file] = true;
      }
    }

    if (Utils.isAIChatSidebar(e.document?.uri)) {
      this.isAICodeGenerating = true;
      this.AIdebounceCount = 0;
    } else if (Utils.isPossibleAICodeInsert(e)) {
      const now = Date.now();
      if (this.recentlyAIPasted(now) && this.hasAICapabilities) {
        this.isAICodeGenerating = true;
        this.AIdebounceCount = 0;
      }
      this.AIrecentPastes.push(now);
    } else if (Utils.isPossibleHumanCodeInsert(e)) {
      this.AIrecentPastes = [];
      if (this.isAICodeGenerating) {
        this.AIdebounceCount++;
        clearTimeout(this.AIDebounceId);
        this.AIDebounceId = setTimeout(() => {
          if (this.AIdebounceCount > 1) {
            this.isAICodeGenerating = false;
          }
        }, this.AIdebounceMs);
      }
    } else if (this.isAICodeGenerating) {
      this.AIdebounceCount = 0;
      clearTimeout(this.AIDebounceId);
      this.updateLineNumbers();
    }
    if (!this.isAICodeGenerating) return;
    this.onEvent(false);
  }

  private onChangeTab(_e: vscode.TextEditor | undefined): void {
    this.logger.debug('onChangeTab');
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidChangeTabs(e: vscode.TabChangeEvent): void {
    this.logger.debug('onDidChangeTabs');
    if (Utils.isCodexCodeReview(e)) {
      this.appendCodeReviewHeartbeat();
      return;
    }
    if (!this.isAICodeGenerating) return;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private async appendCodeReviewHeartbeat(): Promise<void> {
    if (this.disabled) return;

    const time = Date.now();
    if (this.lastCodeReviewing && !Utils.enoughTimePassed(this.lastHeartbeat, time)) return;

    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    const file = doc ? Utils.getFocusedFile(doc) : undefined;
    const entity = file ?? 'Codex Diff';

    const heartbeat: Heartbeat = {
      entity,
      time: time / 1000,
      is_write: false,
      category: 'code reviewing',
    };

    if (doc) {
      heartbeat.lines = doc.lineCount;
      heartbeat.lines_in_file = doc.lineCount;
      if (editor) {
        heartbeat.lineno = editor.selection.start.line + 1;
        heartbeat.cursorpos = editor.selection.start.character + 1;
      }
      const language = this.getLanguage(doc);
      if (language) heartbeat.language = language;
      const folder = this.getProjectFolder(doc.uri);
      if (folder && file && file.indexOf(folder) === 0) {
        heartbeat.project_root_count = this.countSlashesInPath(folder);
      }
      if (doc.isUntitled) heartbeat.is_unsaved_entity = true;
    } else {
      heartbeat.entity_type = 'app';
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (wsf) heartbeat.project_folder = wsf.uri.fsPath;
    }

    const project = this.getProjectName(doc?.uri);
    if (project) {
      heartbeat.project = project;
      heartbeat.alternate_project = project;
    }

    this.lastFile = entity;
    this.lastHeartbeat = time;
    this.lastCodeReviewing = true;

    this.logger.debug(
      `Appending code-reviewing heartbeat to local buffer: ${JSON.stringify(heartbeat, null, 2)}`,
    );
    this.heartbeats.push(heartbeat);
    await this.saveOfflineQueue();

    if (Date.now() - this.lastSent > SEND_BUFFER_SECONDS * 1000) {
      await this.sendHeartbeats();
    }
  }

  private onSave(e: vscode.TextDocument | undefined): void {
    this.logger.debug('onSave');

    const file = Utils.getFocusedFile(e);
    if (file) {
      this.filesWithHumanTyping[file] = true;
    }

    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(true);
  }

  private onChangeNotebook(_e: vscode.NotebookDocumentChangeEvent): void {
    this.logger.debug('onChangeNotebook');
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onSaveNotebook(_e: vscode.NotebookDocument | undefined): void {
    this.logger.debug('onSaveNotebook');
    this.updateLineNumbers();
    this.onEvent(true);
  }

  private updateLineNumbers(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    const file = Utils.getFocusedFile(doc);
    if (!file) return;

    const now = Date.now();
    const current = doc.lineCount;
    if (this.linesInFiles[file] === undefined) {
      this.linesInFiles[file] = { lines: current, updatedAt: now };
    }

    const prev = this.linesInFiles[file] ?? { lines: current, updatedAt: now };
    let delta = current - prev.lines;

    // prevent counting large copy/paste as human typed lines of code
    if (delta > 50 && Math.abs(now - prev.updatedAt) < 60000) {
      delta = 0;
    }

    this.linesInFiles[file] = { lines: current, updatedAt: now };
  }

  private onEvent(isWrite: boolean): void {
    if (Date.now() - this.lastSent > SEND_BUFFER_SECONDS * 1000) {
      this.sendHeartbeats();
    }
    clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => {
      if (this.disabled) return;
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const doc = editor.document;
        if (doc) {
          const file = Utils.getFocusedFile(doc);
          if (!file) {
            return;
          }
          if (this.currentlyFocusedFile !== file) {
            this.updateTeamStatusBarFromJson();
            this.updateTeamStatusBar(doc);
          }

          const time: number = Date.now();
          if (
            isWrite ||
            Utils.enoughTimePassed(this.lastHeartbeat, time) ||
            this.lastFile !== file ||
            this.lastDebug !== this.isDebugging ||
            this.lastCompile !== this.isCompiling ||
            this.lastAICodeGenerating !== this.isAICodeGenerating
          ) {
            this.appendHeartbeat(
              doc,
              time,
              editor.selection.start,
              isWrite,
              this.isCompiling,
              this.isDebugging,
              this.isAICodeGenerating,
            );
            this.lastFile = file;
            this.lastHeartbeat = time;
            this.lastDebug = this.isDebugging;
            this.lastCompile = this.isCompiling;
            this.lastAICodeGenerating = this.isAICodeGenerating;
          }
        }
      }
    }, this.debounceMs);
  }

  private async appendHeartbeat(
    doc: vscode.TextDocument,
    time: number,
    selection: vscode.Position,
    isWrite: boolean,
    isCompiling: boolean,
    isDebugging: boolean,
    isAICoding: boolean,
  ): Promise<void> {
    const file = Utils.getFocusedFile(doc);
    if (!file) return;

    // prevent sending the same heartbeat (https://github.com/wakatime/vscode-wakatime/issues/163)
    if (isWrite && this.isDuplicateHeartbeat(file, time, selection)) return;

    const now = Date.now();

    const heartbeat: Heartbeat = {
      entity: file,
      time: now / 1000,
      is_write: isWrite,
      lineno: selection.line + 1,
      cursorpos: selection.character + 1,
      lines: doc.lineCount,
      lines_in_file: doc.lineCount,
    };

    // Remove human line changes if we never detected human typing
    if (!this.filesWithHumanTyping[file]) heartbeat.human_line_changes = 0;
    this.filesWithHumanTyping[file] = false;

    this.lineChanges = { ai: {}, human: {} };

    if (isDebugging) {
      heartbeat.category = 'debugging';
    } else if (isCompiling) {
      heartbeat.category = 'building';
    } else if (isAICoding) {
      heartbeat.category = 'ai coding';
    } else if (Utils.isPullRequest(doc.uri)) {
      heartbeat.category = 'code reviewing';
    }
    this.lastCodeReviewing = heartbeat.category === 'code reviewing';

    if (heartbeat.ai_line_changes) {
      heartbeat.ai_line_changes = this.lineChanges.ai[file];
    }
    if (heartbeat.human_line_changes) {
      heartbeat.human_line_changes = this.lineChanges.human[file];
    }

    const project = this.getProjectName(doc.uri);
    if (project) {
      heartbeat.project = project;
      heartbeat.alternate_project = project;
    }

    const folder = this.getProjectFolder(doc.uri);
    if (folder && file.indexOf(folder) === 0) {
      heartbeat.project_root_count = this.countSlashesInPath(folder);
    }

    const language = this.getLanguage(doc);
    if (language) heartbeat.language = language;

    if (doc.isUntitled) heartbeat.is_unsaved_entity = true;

    this.logger.debug(`Appending heartbeat to local buffer: ${JSON.stringify(heartbeat, null, 2)}`);
    this.heartbeats.push(heartbeat);
    await this.saveOfflineQueue();

    if (now - this.lastSent > SEND_BUFFER_SECONDS * 1000) {
      await this.sendHeartbeats();
    }
  }

  private async loadOfflineQueue(): Promise<void> {
    try {
      const saved = this.config.get<Heartbeat[]>('wakatime.offlineQueue');
      if (Array.isArray(saved) && saved.length > 0) {
        this.heartbeats.push(...saved);
      }
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (wsf && wsf.uri.scheme === 'orbit') {
        const qUri = vscode.Uri.joinPath(wsf.uri, '.hackatime-queue.json');
        const raw = await vscode.workspace.fs.readFile(qUri);
        const diskQueue = JSON.parse(new TextDecoder().decode(raw));
        if (Array.isArray(diskQueue) && diskQueue.length > 0 && (!saved || saved.length === 0)) {
          this.heartbeats.push(...diskQueue);
        }
      }
    } catch (_) {}
  }

  private async saveOfflineQueue(): Promise<void> {
    try {
      if (this.heartbeats.length > 2000) {
        this.heartbeats = this.heartbeats.slice(-2000);
      }
      await this.config.update('wakatime.offlineQueue', this.heartbeats);
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (wsf && wsf.uri.scheme === 'orbit') {
        const qUri = vscode.Uri.joinPath(wsf.uri, '.hackatime-queue.json');
        if (this.heartbeats.length === 0) {
          try {
            await vscode.workspace.fs.delete(qUri);
          } catch (_) {}
        } else {
          await vscode.workspace.fs.writeFile(
            qUri,
            new TextEncoder().encode(JSON.stringify(this.heartbeats)),
          );
        }
      }
    } catch (_) {}
  }

  private async sendHeartbeats(): Promise<void> {
    this.hasApiKey((hasApiKey) => {
      if (hasApiKey) {
        this._sendHeartbeats();
      } else {
        this.promptForApiKey();
      }
    });
  }

  private async _sendHeartbeats() {
    if (this.heartbeats.length === 0) return;

    this.lastSent = Date.now();

    const plugin = this.getPlugin();
    const batch = this.heartbeats.slice(0, 100);
    const payload = batch.map((h) => {
      const { entity_type, ...rest } = h;
      return {
        type: entity_type ?? 'file',
        plugin,
        ...rest,
      };
    });

    this.logger.debug(`Sending heartbeats to API: ${JSON.stringify(payload)}`);

    const apiKey = this.getApiKey();
    const apiUrl = this.getApiUrl();
    const url = `${apiUrl}/users/current/heartbeats.bulk?api_key=${encodeURIComponent(apiKey)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Machine-Name': vscode.env.appHost,
        },
        body: JSON.stringify(payload),
      });
      const parsedJSON = await response.json();
      if (response.status == 200 || response.status == 201 || response.status == 202) {
        this.heartbeats.splice(0, batch.length);
        await this.saveOfflineQueue();
        if (this.heartbeats.length > 0) {
          await this._sendHeartbeats();
        } else if (this.showStatusBar) {
          this.getCodingActivity();
        }
      } else {
        this.logger.warn(`API Error ${response.status}: ${JSON.stringify(parsedJSON)}`);
        if (response && response.status == 401) {
          const error_msg = 'Invalid Hackatime Api Key';
          if (this.showStatusBar) {
            this.updateStatusBarText('Hackatime Error');
            this.updateStatusBarTooltip(`Hackatime: ${error_msg}`);
          }
          this.logger.error(error_msg);
          const now: number = Date.now();
          if (this.lastApiKeyPrompted < now - 86400000) {
            // only prompt once per day
            this.promptForApiKey(false);
            this.lastApiKeyPrompted = now;
          }
        } else {
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            // Drop malformed batch so it doesn't block the queue forever
            this.heartbeats.splice(0, batch.length);
            await this.saveOfflineQueue();
          }
          const error_msg = `Error sending heartbeats (${response.status}); Check your browser console for more details.`;
          if (this.showStatusBar) {
            this.updateStatusBarText('Hackatime Error');
            this.updateStatusBarTooltip(`Hackatime: ${error_msg}`);
          }
          this.logger.error(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`Offline / network error sending heartbeats, queued (${this.heartbeats.length}): ${ex}`);
      await this.saveOfflineQueue();
      if (this.showStatusBar) {
        this.updateStatusBarText(`Offline (${this.heartbeats.length} queued)`);
        this.updateStatusBarTooltip(
          `Hackatime: Working offline — ${this.heartbeats.length} heartbeat(s) saved and will sync automatically when back online.`,
        );
      }
    }
  }

  private getCodingActivity() {
    if (!this.showStatusBar) return;

    const cutoff = Date.now() - this.fetchTodayInterval;
    if (this.lastFetchToday > cutoff) return;

    this.lastFetchToday = Date.now();

    this.hasApiKey((hasApiKey) => {
      if (!hasApiKey) return;
      this._getCodingActivity();
    });
  }

  private async _getCodingActivity() {
    this.logger.debug('Fetching coding activity for Today from api.');
    const apiKey = this.getApiKey();
    const apiUrl = this.getApiUrl();
    const url = `${apiUrl}/users/current/statusbar/today?api_key=${encodeURIComponent(apiKey)}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      });
      const parsedJSON = await response.json();
      if (response.status == 200) {
        this.config.get('wakatime.status_bar_coding_activity');
        if (this.showStatusBar) {
          if (parsedJSON.data) this.hasTeamFeatures = parsedJSON.data.has_team_features;
          let output = parsedJSON.data?.grand_total?.text;
          if (
            this.config.get('wakatime.status_bar_hide_categories') != 'true' &&
            Array.isArray(parsedJSON.data?.categories) &&
            parsedJSON.data.categories.length > 1
          ) {
            output = parsedJSON.data.categories.map((x) => x.text + ' ' + x.name).join(', ');
          }
          if (output && output.trim()) {
            if (this.showCodingActivity) {
              this.updateStatusBarText(output.trim());
              this.updateStatusBarTooltip(
                'Hackatime: Today’s coding time. Click to visit dashboard.',
              );
            } else {
              this.updateStatusBarText();
              this.updateStatusBarTooltip(output.trim());
            }
          } else {
            this.updateStatusBarText();
            this.updateStatusBarTooltip('Hackatime: Calculating time spent today in background...');
          }
        }
      } else {
        this.logger.warn(`API Error ${response.status}: ${JSON.stringify(parsedJSON)}`);
        if (response && response.status == 401) {
          const error_msg = 'Invalid Hackatime Api Key';
          if (this.showStatusBar) {
            this.updateStatusBarText('Hackatime Error');
            this.updateStatusBarTooltip(`Hackatime: ${error_msg}`);
          }
          this.logger.error(error_msg);
        } else {
          const error_msg = `Error fetching code stats for status bar (${response.status}); Check your browser console for more details.`;
          this.logger.debug(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
    }
  }

  private async updateTeamStatusBar(doc?: vscode.TextDocument) {
    if (!this.showStatusBarTeam) return;
    if (!this.hasTeamFeatures) return;

    if (!doc) {
      doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
    }

    const file = Utils.getFocusedFile(doc);
    if (!file) {
      return;
    }

    this.currentlyFocusedFile = file;

    if (this.teamDevsForFileCache[file]) {
      this.updateTeamStatusBarFromJson(this.teamDevsForFileCache[file]);
      return;
    }

    this.logger.debug('Fetching devs for currently focused file from api.');
    const apiKey = this.config.get('wakatime.apiKey');
    const apiUrl = this.getApiUrl();
    const url = `${apiUrl}/users/current/file_experts?api_key=${apiKey}`;

    const payload = {
      entity: file,
      plugin: this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version,
    };

    const project = this.getProjectName();
    if (!project) return;
    payload['project'] = project;

    const folder = this.getProjectFolder(doc.uri);
    if (!folder || file.indexOf(folder) !== 0) return;
    payload['project_root_count'] = this.countSlashesInPath(folder);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version,
        },
        body: JSON.stringify(payload),
      });
      const parsedJSON = await response.json();
      if (response.status == 200) {
        const devs = {
          you: null,
          other: null,
        };
        if (parsedJSON.data) {
          const currentUser = parsedJSON.data.find((dev) => dev.user.is_current_user);
          let topDev = parsedJSON.data[0];
          if (topDev.user.is_current_user) {
            if (parsedJSON.data.length > 1) {
              topDev = parsedJSON.data[1];
            } else {
              topDev = null;
            }
          }

          devs.you = currentUser;
          devs.other = topDev;
          this.teamDevsForFileCache[file] = devs;
        }

        // make sure this file is still the currently focused file
        if (file !== this.currentlyFocusedFile) return;

        this.config.get('wakatime.status_bar_coding_activity');
        if (this.showStatusBar) {
          this.updateTeamStatusBarFromJson(devs);
        }
      } else {
        this.updateTeamStatusBarTextForCurrentUser();
        this.updateTeamStatusBarTextForOther();
        this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
        if (response && response.status == 401) {
          this.logger.error('Invalid WakaTime Api Key');
        } else {
          const error_msg = `Error fetching devs for currently focused file (${response.status}); Check your browser console for more details.`;
          this.logger.debug(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
    }
  }

  private updateTeamStatusBarFromJson(jsonData?: any) {
    if (!jsonData) {
      this.updateTeamStatusBarTextForCurrentUser();
      this.updateTeamStatusBarTextForOther();
      return;
    }

    const you = jsonData.you;
    const other = jsonData.other;

    if (you) {
      this.updateTeamStatusBarTextForCurrentUser('You: ' + you.total.text);
      this.updateStatusBarTooltipForCurrentUser('Your total time spent in this file');
    } else {
      this.updateTeamStatusBarTextForCurrentUser();
    }
    if (other) {
      this.updateTeamStatusBarTextForOther(other.user.name + ': ' + other.total.text);
      this.updateStatusBarTooltipForOther(
        other.user.long_name + '’s total time spent in this file',
      );
    } else {
      this.updateTeamStatusBarTextForOther();
    }
  }

  private recentlyAIPasted(time: number): boolean {
    this.AIrecentPastes = this.AIrecentPastes.filter((x) => x + AI_RECENT_PASTES_TIME_MS >= time);
    return this.AIrecentPastes.length > 3;
  }

  private isDuplicateHeartbeat(file: string, time: number, selection: vscode.Position): boolean {
    let duplicate = false;
    const minutes = 30;
    const milliseconds = minutes * 60000;
    if (
      this.dedupe[file] &&
      this.dedupe[file].lastHeartbeatAt + milliseconds < time &&
      this.dedupe[file].selection.line == selection.line &&
      this.dedupe[file].selection.character == selection.character
    ) {
      duplicate = true;
    }
    this.dedupe[file] = {
      selection: selection,
      lastHeartbeatAt: time,
    };
    return duplicate;
  }

  private getLanguage(doc: vscode.TextDocument): string {
    return doc.languageId || '';
  }

  private getProjectName(uri?: vscode.Uri): string {
    if (uri && uri.scheme === 'orbit' && uri.path.startsWith('/Orbit/')) {
      const rest = uri.path.slice('/Orbit/'.length);
      const slash = rest.indexOf('/');
      if (slash > 0) return rest.slice(0, slash);
    }
    return vscode.workspace.name || 'Orbit';
  }

  private getProjectFolder(uri: vscode.Uri): string {
    if (!vscode.workspace) return '';
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      try {
        return workspaceFolder.uri.fsPath;
      } catch (e) {}
    }
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return '';
  }

  private getPlugin(): string {
    const agent = `${this.agentName}/${vscode.version} vscode-wakatime/${this.extension.version}`;
    const os = this.getOperatingSystem();
    if (os) return `(${os}) ${agent}`;
    return agent;
  }

  private getOperatingSystem(): string | null {
    if ((navigator as any).userAgentData && (navigator as any).userAgentData.platform) {
      const platform = (navigator as any).userAgentData.platform as string;
      if (platform.toLowerCase().indexOf('mac') != -1) return 'Mac';
      if (platform.toLowerCase().indexOf('win') != -1) return 'Windows';
      if (platform.toLowerCase().indexOf('linux') != -1) return 'Linux';
      if (platform.toLowerCase().indexOf('unix') != -1) return 'Unix';
      if (platform.toLowerCase().indexOf('android') != -1) return 'Android';
      return platform;
    }
    if (navigator.platform) {
      const platform = navigator.platform;
      if (navigator.userAgent && navigator.userAgent.toLowerCase().indexOf('android') != -1)
        return 'Android';
      if (platform.toLowerCase().indexOf('mac') != -1) return 'Mac';
      if (platform.toLowerCase().indexOf('win') != -1) return 'Windows';
      if (platform.toLowerCase().indexOf('linux') != -1) return 'Linux';
      if (platform.toLowerCase().indexOf('unix') != -1) return 'Unix';
      if (platform.toLowerCase().indexOf('android') != -1) return 'Android';
      return platform;
    }
    return null;
  }

  private getApiUrl(): string {
    return HACKATIME_API_URL;
  }

  private countSlashesInPath(path: string): number {
    if (!path) return 0;

    const windowsNetDrive = path.indexOf('\\\\') === 0;

    path = path.replace(/[\\/]+/, '/');

    if (windowsNetDrive) {
      path = '\\\\' + path.slice(1);
    }

    if (!path.endsWith('/')) path = path + '/';

    return (path.match(/\//g) || []).length;
  }
}
