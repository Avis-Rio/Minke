import {
  isDesktopLocale,
  resolveDesktopLocale,
  type DesktopLocale,
} from "./locale-contract.ts";

const zh = {
  "edit.undo": "撤销",
  "edit.redo": "重做",
  "edit.cut": "剪切",
  "edit.copy": "复制",
  "edit.paste": "粘贴",
  "edit.selectAll": "全选",
  "quit.title": "退出 Minke？",
  "quit.restartTitle": "重新启动 Minke？",
  "quit.active": "仍有运行中的任务、排队消息或后台作业。退出将中断这些工作。",
  "quit.scheduled": "当前有已启用的定时提醒。退出后，提醒将暂停，直到再次打开 Minke。",
  "quit.activeAndScheduled": "仍有运行中的工作和已启用的定时提醒。退出将中断工作并暂停提醒。",
  "quit.unknown": "暂时无法确认任务状态。退出可能中断正在运行的工作。",
  "quit.cancel": "取消",
  "recovery.title": "Minke 遇到错误",
  "recovery.message": "应用无法继续正常运行。重新启动将停止当前工作并重新打开 Minke。",
  "recovery.report": "诊断文件：{path}",
  "recovery.safeMode": "以插件安全模式重启",
  "recovery.failed": "恢复操作未完成，可以重试或退出。",
  "bootstrap.loading": "正在启动 Minke",
  "runtime.restart": "重新启动",
  "runtime.quit": "退出 Minke",
  "runtime.navigationFailedTitle": "无法加载 Minke 界面",
  "runtime.navigationFailedMessage":
    "页面加载未完成。可以重试加载，或退出 Minke。",
  "runtime.retryNavigation": "重新加载",
  "menu.file": "文件",
  "menu.view": "视图",
  "menu.commandPalette": "命令面板…",
  "menu.settings": "设置…",
  "menu.newSession": "新建会话",
  "menu.newRightTab": "在右栏新建 Tab",
  "menu.newBottomTab": "在底栏新建 Tab",
  "menu.newTab.files": "文件管理器",
  "menu.newTab.terminal": "终端",
  "menu.newTab.browser": "常驻浏览器",
  "menu.newTab.browserHistory": "浏览历史",
  "menu.newTab.plugins": "插件",
  "menu.focusComposer": "聚焦消息输入框",
  "menu.sessionBack": "返回上一会话",
  "menu.sessionForward": "前往下一会话",
  "menu.toggleSidebar": "展开或折叠左侧栏",
  "menu.toggleRightSidebar": "展开或折叠右侧栏",
  "menu.toggleBottomPanel": "展开或折叠底部栏",
  "sessionExport.saveDialogTitle": "导出 Session 日志",
  "sessionExport.zipFilter": "ZIP 归档",
  "sessionExport.failedTitle": "无法导出 Session 日志",
  "sessionExport.failedMessage": "Session 日志导出失败。",
  "sessionExport.ok": "确定",
  "update.availableTitle": "Minke 更新",
  "update.upToDate": "当前已是最新版本。",
  "update.unavailable": "当前构建不支持应用更新。",
  "update.availableMessage": "Minke {version} 已发布",
  "update.availableDetail":
    "当前版本为 {current}。Minke 将从不可变 GitHub Release 下载对应平台的安装包，并校验下载地址、大小、SHA-256，以及系统提供下载来源标记时的来源属性。",
  "update.download": "下载更新",
  "update.later": "稍后",
  "update.readyTitle": "更新已验证",
  "update.readyMessage": "Minke {version} 更新包已准备好",
  "update.readyDetail.dmg":
    "将打开 DMG。请退出 Minke 后，将新版本拖入“应用程序”。若 macOS 拦截，请在“系统设置 → 隐私与安全性”中审查并手动允许；Minke 不会自动移除隔离属性。",
  "update.readyDetail.exe":
    "将启动 Windows 安装程序。安装程序仍保留 Mark-of-the-Web，Windows 可能显示 SmartScreen 提示；请核对发布者与版本后继续。",
  "update.readyDetail.deb":
    "将用系统默认的软件安装器打开 DEB。安装时可能需要管理员授权；请按系统提示完成安装。",
  "update.readyDetail.rpm":
    "将用系统默认的软件安装器打开 RPM。安装时可能需要管理员授权；请按系统提示完成安装。",
  "update.readyDetail.appimage":
    "将在文件管理器中显示已验证的 AppImage。请退出 Minke，用新文件替换当前 AppImage，并保留其可执行权限。",
  "update.openInstaller": "打开安装包",
  "update.showAppImage": "显示 AppImage",
  "update.failedTitle": "无法安全下载更新",
  "update.failedMessage": "Minke 未打开未通过校验的安装包。",
  "update.failedDetail":
    "{error}\n\n你可以改用浏览器打开官方 Release 页面。",
  "update.openReleasePage": "打开 Release 页面",
  "update.cancel": "取消",
  "update.retry": "重试",
  "shortcuts.migrationTitle": "部分快捷键需要重新设置",
  "shortcuts.migrationDetail": "以下组合不受当前快捷键编辑器支持，已暂时取消绑定：\n{bindings}\n\n原设置保留在 {path}。请在 Settings → General → Keyboard shortcuts 中重新设置。",
} as const;

export type DesktopMessageKey = keyof typeof zh;

const en: Record<DesktopMessageKey, string> = {
  "edit.undo": "Undo",
  "edit.redo": "Redo",
  "edit.cut": "Cut",
  "edit.copy": "Copy",
  "edit.paste": "Paste",
  "edit.selectAll": "Select All",
  "quit.title": "Quit Minke?",
  "quit.restartTitle": "Restart Minke?",
  "quit.active": "Tasks, queued messages, or background jobs are still active. Quitting will interrupt this work.",
  "quit.scheduled": "Scheduled reminders are armed. Quitting will pause them until you reopen Minke.",
  "quit.activeAndScheduled": "Work is still active and scheduled reminders are armed. Quitting will interrupt work and pause reminders.",
  "quit.unknown": "Task status is unavailable. Quitting may interrupt active work.",
  "quit.cancel": "Cancel",
  "recovery.title": "Minke encountered an error",
  "recovery.message": "The application cannot continue normally. Restarting will stop current work and reopen Minke.",
  "recovery.report": "Diagnostic file: {path}",
  "recovery.safeMode": "Restart in plugin safe mode",
  "recovery.failed": "Recovery did not finish. You can retry or quit.",
  "bootstrap.loading": "Starting Minke",
  "runtime.restart": "Restart",
  "runtime.quit": "Quit Minke",
  "runtime.navigationFailedTitle": "Unable to load Minke",
  "runtime.navigationFailedMessage":
    "The page did not finish loading. You can try loading it again or quit Minke.",
  "runtime.retryNavigation": "Reload",
  "menu.file": "File",
  "menu.view": "View",
  "menu.commandPalette": "Command Palette…",
  "menu.settings": "Settings…",
  "menu.newSession": "New Session",
  "menu.newRightTab": "New Tab in Right Panel",
  "menu.newBottomTab": "New Tab in Bottom Panel",
  "menu.newTab.files": "File Manager",
  "menu.newTab.terminal": "Terminal",
  "menu.newTab.browser": "Persistent Browser",
  "menu.newTab.browserHistory": "Browser History",
  "menu.newTab.plugins": "Plugins",
  "menu.focusComposer": "Focus Message Input",
  "menu.sessionBack": "Back to Previous Session",
  "menu.sessionForward": "Forward to Next Session",
  "menu.toggleSidebar": "Toggle Sidebar",
  "menu.toggleRightSidebar": "Toggle Right Sidebar",
  "menu.toggleBottomPanel": "Toggle Bottom Panel",
  "sessionExport.saveDialogTitle": "Export Session log",
  "sessionExport.zipFilter": "ZIP archives",
  "sessionExport.failedTitle": "Unable to export Session log",
  "sessionExport.failedMessage":
    "The Session log could not be exported.",
  "sessionExport.ok": "OK",
  "update.availableTitle": "Minke update",
  "update.upToDate": "Minke is up to date.",
  "update.unavailable": "Application updates are unavailable in this build.",
  "update.availableMessage": "Minke {version} is available",
  "update.availableDetail":
    "The current version is {current}. Minke will download the platform installer from an immutable GitHub Release and verify its URL, size, SHA-256 digest, and OS provenance marker when the platform provides one.",
  "update.download": "Download update",
  "update.later": "Later",
  "update.readyTitle": "Update verified",
  "update.readyMessage": "The Minke {version} update is ready",
  "update.readyDetail.dmg":
    "The DMG will open. Quit Minke before dragging the new version into Applications. If macOS blocks it, review and allow it manually in System Settings → Privacy & Security; Minke never removes the quarantine attribute automatically.",
  "update.readyDetail.exe":
    "The Windows installer will launch. Its Mark-of-the-Web remains intact, so Windows may show SmartScreen; verify the publisher and version before continuing.",
  "update.readyDetail.deb":
    "The DEB will open in the system package installer. Administrator authorization may be required; follow the operating-system prompts to finish.",
  "update.readyDetail.rpm":
    "The RPM will open in the system package installer. Administrator authorization may be required; follow the operating-system prompts to finish.",
  "update.readyDetail.appimage":
    "The verified AppImage will be shown in the file manager. Quit Minke, replace the current AppImage with the new file, and keep it executable.",
  "update.openInstaller": "Open installer",
  "update.showAppImage": "Show AppImage",
  "update.failedTitle": "Unable to download update safely",
  "update.failedMessage":
    "Minke did not open an installer that failed verification.",
  "update.failedDetail":
    "{error}\n\nYou can use a browser to open the official Release page instead.",
  "update.openReleasePage": "Open Release page",
  "update.cancel": "Cancel",
  "update.retry": "Retry",
  "shortcuts.migrationTitle": "Some shortcuts need to be reassigned",
  "shortcuts.migrationDetail": "These combinations are unsupported by the current shortcut editor and have been unbound:\n{bindings}\n\nYour original settings remain at {path}. Reassign them in Settings → General → Keyboard shortcuts.",
};

export const desktopDictionaries = Object.freeze({
  zh: Object.freeze(zh),
  en: Object.freeze(en),
});

export type DesktopTranslateParams = Readonly<
  Record<string, unknown>
>;

/** Translate one desktop-owned native string using Harness-compatible braces. */
export function translateDesktop(
  locale: DesktopLocale,
  key: DesktopMessageKey,
  params?: DesktopTranslateParams,
): string {
  const template =
    desktopDictionaries[resolveDesktopLocale(locale)][key];
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    params !== undefined && Object.hasOwn(params, name)
      ? String(params[name])
      : match,
  );
}

export type DesktopLocaleSnapshot = Readonly<{
  active: DesktopLocale;
  revision: number;
}>;

/** In-memory desktop projection of Harness's authoritative active locale. */
export class DesktopLocaleRuntime {
  #snapshot: DesktopLocaleSnapshot;
  readonly #listeners = new Set<() => void>();

  constructor(initial: DesktopLocale) {
    this.#snapshot = Object.freeze({
      active: isDesktopLocale(initial) ? initial : "en",
      revision: 0,
    });
  }

  getSnapshot(): DesktopLocaleSnapshot {
    return this.#snapshot;
  }

  setLocale(locale: DesktopLocale): void {
    if (!isDesktopLocale(locale)) return;
    if (locale === this.#snapshot.active) return;
    this.#snapshot = Object.freeze({
      active: locale,
      revision: this.#snapshot.revision + 1,
    });
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  t(
    key: DesktopMessageKey,
    params?: DesktopTranslateParams,
  ): string {
    return translateDesktop(this.#snapshot.active, key, params);
  }
}
