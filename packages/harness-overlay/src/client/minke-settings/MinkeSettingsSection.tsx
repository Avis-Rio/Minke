import {
  DatabaseBackup,
  Globe,
  SlidersHorizontal,
  type LucideIconData,
} from "@lucide/icons";
import { Button, SegmentedTabs, type SegmentedTab } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  LucideIcon,
} from "../tabs/components/LucideIcon.ts";
import type {
  MinkeSettingsTranslate,
} from "./locales.ts";
import type {
  MinkeSettingsPage,
  MinkeSettingsPageIcon,
  MinkeSettingsRuntime,
} from "./runtime.ts";

const PAGE_ICONS: Readonly<
  Record<MinkeSettingsPageIcon, LucideIconData>
> = {
  preferences: SlidersHorizontal,
  browser: Globe,
  "data-home": DatabaseBackup,
};

interface MinkeSettingsPageContentProps {
  page: MinkeSettingsPage;
}

function MinkeSettingsPageContent({
  page,
}: MinkeSettingsPageContentProps): ReactNode {
  return page.render();
}

interface MinkeSettingsPageBoundaryProps {
  children: ReactNode;
  label: string;
  t: MinkeSettingsTranslate;
}

interface MinkeSettingsPageBoundaryState {
  failed: boolean;
}

/** Keep one failing contribution from taking down every Minke settings page. */
class MinkeSettingsPageBoundary extends Component<
  MinkeSettingsPageBoundaryProps,
  MinkeSettingsPageBoundaryState
> {
  state: MinkeSettingsPageBoundaryState = {
    failed: false,
  };

  static getDerivedStateFromError(): MinkeSettingsPageBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `Minke Settings page "${this.props.label}" failed`,
      error,
      info.componentStack,
    );
  }

  #retry = (): void => {
    this.setState({ failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="minke-settings__page-error" role="alert">
        <p>{this.props.t("pageError")}</p>
        <Button size="sm" variant="outline" onClick={this.#retry}>
          {this.props.t("retry")}
        </Button>
      </div>
    );
  }
}

export interface MinkeSettingsSectionProps {
  runtime: MinkeSettingsRuntime;
  t: MinkeSettingsTranslate;
}

/**
 * Keep all Minke-owned configuration in one DSH Settings section.
 *
 * Compact labeled tabs keep each product settings area discoverable while
 * preserving keyboard navigation and stable positions.
 */
export function MinkeSettingsSection({
  runtime,
  t,
}: MinkeSettingsSectionProps): ReactNode {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const idPrefix = useId();
  const rootRef = useRef<HTMLElement>(null);
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(
    () => new Set(
      snapshot.activeId === undefined ? [] : [snapshot.activeId],
    ),
  );

  useEffect(() => {
    const activeId = snapshot.activeId;
    if (activeId === undefined) return;
    setVisitedIds((previous) => {
      if (previous.has(activeId)) return previous;
      return new Set([...previous, activeId]);
    });
  }, [snapshot.activeId]);

  const selectPage = (id: string): void => {
    runtime.select(id);
    rootRef.current?.scrollIntoView({
      block: "start",
      behavior: "instant",
    });
  };

  const [firstTab, ...remainingTabs] = snapshot.pages.map((page): SegmentedTab => ({
    value: page.id,
    id: `${idPrefix}-tab-${page.id}`,
    panelId: `${idPrefix}-panel-${page.id}`,
    label: <>
      <LucideIcon icon={PAGE_ICONS[page.icon]} size={16} />
      <span className="minke-settings__tab-label">{page.label()}</span>
    </>,
  }));

  return (
    <section
      ref={rootRef}
      className="minke-settings"
      data-minke-settings
    >
      {firstTab === undefined
        ? (
          <p className="minke-settings__empty" role="status">
            {t("empty")}
          </p>
        )
        : (
          <>
            <div className="minke-settings__tabs-shell">
              <SegmentedTabs
                className="minke-settings__tabs"
                items={[firstTab, ...remainingTabs]}
                value={snapshot.activeId ?? firstTab.value}
                onChange={selectPage}
                label={t("title")}
              />
            </div>
            <div className="minke-settings__pages">
              {snapshot.pages.map((page) => {
                const tabId = `${idPrefix}-tab-${page.id}`;
                const panelId = `${idPrefix}-panel-${page.id}`;
                // Preserve drafts after a page's first visit.
                const mounted = page.id === snapshot.activeId || visitedIds.has(page.id);
                return (
                  <div
                    key={page.id}
                    id={panelId}
                    className="minke-settings__page"
                    role="tabpanel"
                    aria-labelledby={tabId}
                    hidden={page.id !== snapshot.activeId}
                  >
                    {mounted
                      ? (
                        <MinkeSettingsPageBoundary
                          label={page.label()}
                          t={t}
                        >
                          <MinkeSettingsPageContent page={page} />
                        </MinkeSettingsPageBoundary>
                      )
                      : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
    </section>
  );
}
