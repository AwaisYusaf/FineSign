import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Back on the left, the step's primary action on the right. */
export function StepFooter({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t pt-6">
      {onBack ? (
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}
