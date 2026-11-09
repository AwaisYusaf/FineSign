import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ArrowRight, FileText, Loader2, CloudUpload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, fileToBase64 } from "@/lib/api";
import { pluralize } from "@/lib/format";
import type { Envelope } from "@/lib/types";
import { cn } from "@/lib/utils";

import { StepFooter } from "./step-footer";

const ACCEPTED = /\.(pdf|docx)$/i;

export function DocumentsStep({
  env,
  onChange,
  onBack,
  onNext,
}: {
  env: Envelope;
  onChange: (env: Envelope) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Upload one at a time: each response is the whole envelope, so order matters. */
  async function upload(files: File[]) {
    for (const file of files) {
      if (!ACCEPTED.test(file.name)) {
        toast.error(`${file.name} isn't a PDF or Word (.docx) file.`);
        continue;
      }
      setUploading(file.name);
      try {
        const format = file.name.toLowerCase().endsWith(".docx") ? "docx" : "pdf";
        onChange(await api.addDocument(env.id, { name: file.name, format, contentBase64: await fileToBase64(file) }));
      } catch (e) {
        toast.error(`Couldn't add ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setUploading(null);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!uploading) void upload([...e.dataTransfer.files]);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-border"
            )}
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              {uploading ? <Loader2 className="size-5 animate-spin text-primary" /> : <CloudUpload className="size-5 text-primary" />}
            </span>
            {uploading ? (
              <p className="text-sm font-medium">Uploading {uploading}…</p>
            ) : (
              <>
                <p className="text-sm font-medium">Drop PDF or Word files here</p>
                <p className="text-xs text-muted-foreground">Word documents are converted to PDF on the server · up to 10 MB each</p>
              </>
            )}
            <Button type="button" variant="outline" size="sm" disabled={!!uploading} onClick={() => inputRef.current?.click()}>
              Browse files
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              className="sr-only"
              aria-label="Upload documents"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void upload(files);
              }}
            />
          </div>

          {env.documents.length > 0 && (
            <ul className="divide-y rounded-lg border" aria-label="Documents">
              {env.documents.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <FileText className="size-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.name}</p>
                    <p className="text-xs text-muted-foreground">{d.pageCount ? pluralize(d.pageCount, "page") : "Converted to PDF"}</p>
                  </div>
                  <Badge variant="outline" className="uppercase">
                    {d.format}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <StepFooter onBack={onBack}>
        <Button onClick={onNext} disabled={env.documents.length === 0 || !!uploading}>
          Continue to recipients <ArrowRight />
        </Button>
      </StepFooter>
    </div>
  );
}
