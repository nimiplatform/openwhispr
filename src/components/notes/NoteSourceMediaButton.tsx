import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeNimiBusiness } from "../../services/nimiClient";
import type { NoteSourceMedia } from "../../types/electron";
import { getNoteMediaChoices, type NoteMediaSelection } from "../../utils/noteMediaChoices";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { ChevronDown, Loader2 } from "../icons";

export function NoteSourceMediaButton({
  noteId,
  media,
  locale,
}: {
  noteId: number;
  media: NoteSourceMedia;
  locale: string;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const choices = useMemo(() => getNoteMediaChoices(media), [media]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const currentNote = useRef(noteId);
  currentNote.current = noteId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reveal = async (selection: NoteMediaSelection) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await invokeNimiBusiness<{ revealed: boolean }>(
        "openwhispr.note.reveal-source",
        { noteId, ...selection }
      );
      if (result?.revealed !== true) throw new Error("Original media was not located");
    } catch (error) {
      if (alive.current && currentNote.current === noteId)
        toast({
          title: t("nimi.recordingMedia.openFailed"),
          description: t("nimi.recordingMedia.checkFile"),
          variant: "destructive",
          technicalDetails: {
            underlyingError: error instanceof Error ? error.message : String(error),
          },
        });
    } finally {
      if (alive.current && currentNote.current === noteId) setBusy(false);
    }
  };
  const label = t("nimi.originalSource");
  if (choices.length === 1 && choices[0].key === "original")
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void reveal({})}
      >
        {label}
      </Button>
    );
  const statusKeys = {
    processing: "processing",
    completed: "completed",
    canceled: "canceled",
    failed: "failed",
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !choices.length}
          aria-busy={busy}
          title={!choices.length ? t("nimi.recordingMedia.unavailable") : undefined}
        >
          {label}
          {busy ? (
            <Loader2 size={12} className="ms-1 animate-spin" aria-hidden="true" />
          ) : (
            <ChevronDown size={12} className="ms-1" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
      >
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.key}
            className="flex flex-col items-start gap-0.5 whitespace-normal"
            onSelect={() => void reveal(choice.selection)}
          >
            {choice.key === "original" ? (
              <>
                <span>{label}</span>
                {media.originalName && (
                  <span className="max-w-full wrap-break-word text-xs text-muted-foreground">
                    {media.originalName}
                  </span>
                )}
              </>
            ) : (
              <>
                <span>
                  {t("nimi.recordingMedia.recording", { number: choice.recordingNumber })} ·{" "}
                  {t(
                    "nimi.recordingMedia.status." +
                      ((choice.status && statusKeys[choice.status]) || "unknown")
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(
                    choice.source === "mic"
                      ? "nimi.recordingMedia.mic"
                      : "nimi.recordingMedia.system"
                  )}
                  {choice.durationSeconds !== undefined && (
                    <>
                      {" "}
                      ·{" "}
                      {t("nimi.recordingMedia.seconds", {
                        seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
                          choice.durationSeconds
                        ),
                      })}
                    </>
                  )}
                </span>
              </>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
