import * as React from "react";

import { respondToManagedAgentPermission } from "@/shared/api/agentControl";
import { subscribeControlResults } from "@/features/agents/observerRelayStore";
import { AlertCircle, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";

import { Button } from "@/shared/ui/button";

import { formatTranscriptTimestampTitle } from "../agentSessionUtils";
import { ActivityRow, ActivityRowLabel } from "./ActivityRow";
import { ToolActivity } from "./ToolActivity";
import type { ActivityRenderClassItemProps } from "./types";

function splitPermissionText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("Options: "))
    .join("\n");
}

function permissionOutcomeTone(outcome: string): "approve" | "deny" | "cancel" {
  if (outcome.startsWith("Approved")) return "approve";
  if (outcome.startsWith("Denied")) return "deny";
  return "cancel";
}

function PermissionActivity(props: ActivityRenderClassItemProps) {
  const { item } = props;
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (item.type !== "lifecycle") return null;
  const request = item.permissionRequest;
  const outcome = item.outcome;
  const tone = outcome ? permissionOutcomeTone(outcome) : null;
  const detail = splitPermissionText(item.text);

  async function answer(optionId: string) {
    if (!request || submitting) return;
    setSubmitting(true);
    setError(null);
    const controlRequestId = crypto.randomUUID();
    try {
      await new Promise<void>((resolve, reject) => {
        let timeout: number;
        const unsubscribe = subscribeControlResults(
          props.agentPubkey,
          (frame) => {
            if (
              frame.type !== "permission_response" ||
              frame.requestId !== controlRequestId ||
              frame.sessionId !== request.sessionId
            ) {
              return;
            }
            window.clearTimeout(timeout);
            unsubscribe();
            if (frame.status === "sent") resolve();
            else reject(new Error(frame.error ?? frame.status));
          },
        );
        timeout = window.setTimeout(() => {
          unsubscribe();
          reject(new Error("No confirmation received"));
        }, 8_000);
        void respondToManagedAgentPermission(
          props.agentPubkey,
          request.sessionId,
          request.nonce,
          optionId,
          controlRequestId,
        ).catch((cause) => {
          window.clearTimeout(timeout);
          unsubscribe();
          reject(cause);
        });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-left text-xs text-amber-700 dark:text-amber-400"
      data-testid="transcript-lifecycle-item"
      title={formatTranscriptTimestampTitle(item.timestamp)}
    >
      {tone === "approve" ? (
        <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" />
      ) : null}
      {tone === "deny" ? (
        <XCircle className="mr-1.5 inline h-3.5 w-3.5" />
      ) : null}
      {!tone ? <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5" /> : null}
      <span className="font-medium">{item.title}</span>
      {detail ? (
        <div className="mt-1 whitespace-pre-wrap opacity-80">{detail}</div>
      ) : null}
      {outcome ? <div className="mt-1 font-medium">{outcome}</div> : null}
      {request && !outcome ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options.map((option) => (
            <Button
              key={option.optionId}
              type="button"
              size="sm"
              variant={option.kind.startsWith("reject") ? "outline" : "default"}
              disabled={submitting}
              data-testid={`permission-option-${option.kind}`}
              onClick={() => void answer(option.optionId)}
            >
              {option.name}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="mt-2 text-destructive">
          Permission response failed: {error}
        </div>
      ) : null}
    </div>
  );
}

export function LifecycleActivity(props: ActivityRenderClassItemProps) {
  if (props.item.type === "tool") {
    return <ToolActivity {...props} />;
  }
  if (props.item.type !== "lifecycle") {
    return null;
  }

  const isError =
    props.item.renderClass === "error" ||
    props.item.title.toLowerCase().includes("error");
  const isPermission = props.item.renderClass === "permission";
  const timestampTitle = formatTranscriptTimestampTitle(props.item.timestamp);

  if (isPermission) {
    return <PermissionActivity {...props} />;
  }

  if (isError) {
    return (
      <div
        className="rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-left text-xs text-destructive"
        data-testid="transcript-lifecycle-item"
        title={timestampTitle}
      >
        <AlertCircle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" />
        <span className="font-medium">{props.item.title}</span>
        {props.item.text ? (
          <span className="opacity-80"> · {props.item.text}</span>
        ) : null}
      </div>
    );
  }

  return (
    <ActivityRow testId="transcript-lifecycle-item" title={timestampTitle}>
      <ActivityRowLabel
        object={props.item.text || undefined}
        openToneScope="none"
        verb={props.item.title}
      />
    </ActivityRow>
  );
}
