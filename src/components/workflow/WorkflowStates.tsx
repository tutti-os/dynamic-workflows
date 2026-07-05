import type { ReactNode } from "react";
import {
  DirectoryIcon,
  FailedLinedIcon,
  Spinner,
} from "@tutti-os/ui-system";

export function LoadingState(props: {
  children: ReactNode;
  fullPage?: boolean;
}) {
  return (
    <div className={props.fullPage ? "loading-state" : "panel-state"}>
      <Spinner />
      {props.children}
    </div>
  );
}

export function EmptyState(props: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {props.icon ?? <DirectoryIcon size={22} />}
      <p>{props.children}</p>
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
