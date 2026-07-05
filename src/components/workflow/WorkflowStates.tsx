import type { ReactNode } from "react";
import {
  Button,
  DirectoryIcon,
  FailedLinedIcon,
  Spinner,
} from "@tutti-os/ui-system";

export function LoadingState(props: {
  children: ReactNode;
  fullPage?: boolean;
  skeleton?: ReactNode;
}) {
  if (props.skeleton) {
    return (
      <div className={props.fullPage ? "loading-state" : "panel-state"}>
        {props.skeleton}
      </div>
    );
  }

  return (
    <div className={props.fullPage ? "loading-state" : "panel-state"}>
      <Spinner />
      {props.children}
    </div>
  );
}

export function EmptyState(props: {
  title?: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: {
    label: string;
    onClick: () => void;
  };
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        {props.icon ?? <DirectoryIcon size={24} />}
      </span>
      <div className="empty-state-copy">
        {props.title ? <h3>{props.title}</h3> : null}
        {props.children ? <p>{props.children}</p> : null}
      </div>
      {props.action ? (
        <Button type="button" variant="outline" onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      ) : null}
    </div>
  );
}

export function ErrorState(props: {
  title?: string;
  message: string;
  fullPage?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      className={props.fullPage ? "error-state error-state-full" : "error-state"}
      role="alert"
    >
      <FailedLinedIcon size={24} />
      <div>
        {props.title ? <h2>{props.title}</h2> : null}
        <p>{props.message}</p>
      </div>
      {props.action}
    </div>
  );
}

export function SkeletonBlock(props: {
  className?: string;
  width?: string;
  height?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={props.className ? `skeleton ${props.className}` : "skeleton"}
      style={{
        width: props.width,
        height: props.height,
      }}
    />
  );
}

export function WorkflowGridSkeleton() {
  return (
    <div className="workflow-grid" aria-label="Loading workflows">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="workflow-card workflow-card-skeleton" key={index}>
          <div className="workflow-card-header">
            <SkeletonBlock className="skeleton-icon" />
            <div className="skeleton-stack">
              <SkeletonBlock height="16px" width="62%" />
              <SkeletonBlock height="12px" width="88%" />
              <SkeletonBlock height="12px" width="52%" />
            </div>
          </div>
          <div className="workflow-card-footer">
            <SkeletonBlock height="20px" width="54px" />
            <SkeletonBlock height="20px" width="80px" />
            <span className="workflow-card-actions">
              <SkeletonBlock height="28px" width="72px" />
              <SkeletonBlock height="28px" width="92px" />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function WorkbenchSkeleton() {
  return (
    <div className="workbench-skeleton" aria-label="Loading workflow">
      <div className="workbench-skeleton-header">
        <SkeletonBlock className="skeleton-icon" />
        <div className="skeleton-stack">
          <SkeletonBlock height="20px" width="240px" />
          <SkeletonBlock height="12px" width="360px" />
        </div>
        <div className="workbench-skeleton-actions">
          <SkeletonBlock height="32px" width="88px" />
          <SkeletonBlock height="32px" width="88px" />
          <SkeletonBlock height="32px" width="88px" />
        </div>
      </div>
      <div className="workbench-skeleton-body">
        <div className="skeleton-pane skeleton-pane-main">
          <SkeletonBlock height="18px" width="180px" />
          <div className="skeleton-graph">
            {Array.from({ length: 6 }, (_, index) => (
              <SkeletonBlock className="skeleton-node" key={index} />
            ))}
          </div>
        </div>
        <div className="skeleton-pane skeleton-pane-side">
          <SkeletonBlock height="18px" width="120px" />
          <SkeletonBlock height="88px" width="100%" />
          <SkeletonBlock height="180px" width="100%" />
          <SkeletonBlock height="120px" width="100%" />
        </div>
      </div>
    </div>
  );
}

export function RunListSkeleton() {
  return (
    <div className="run-list" aria-label="Loading runs">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="run-row" key={index}>
          <div className="run-row-main">
            <SkeletonBlock className="skeleton-dot" />
            <div className="skeleton-stack">
              <SkeletonBlock height="13px" width="150px" />
              <SkeletonBlock height="11px" width="210px" />
            </div>
            <SkeletonBlock height="20px" width="72px" />
            <SkeletonBlock height="12px" width="70px" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RunDetailSkeleton() {
  return (
    <div className="run-detail-skeleton" aria-label="Loading run detail">
      <div className="run-detail-header">
        <div className="run-detail-meta">
          <SkeletonBlock height="20px" width="76px" />
          <SkeletonBlock height="20px" width="48px" />
          <SkeletonBlock height="12px" width="160px" />
        </div>
        <SkeletonBlock height="28px" width="82px" />
      </div>
      <div className="run-facts">
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonBlock height="54px" width="100%" key={index} />
        ))}
      </div>
      <SkeletonBlock height="160px" width="100%" />
      <SkeletonBlock height="160px" width="100%" />
    </div>
  );
}
