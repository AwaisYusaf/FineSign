import { Link } from "react-router";
import { FileQuestion } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Page not found"
      description="That address doesn't match anything in FineSign."
      action={
        <Button asChild variant="outline">
          <Link to="/">Back to envelopes</Link>
        </Button>
      }
    />
  );
}
