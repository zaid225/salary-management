import { Button } from "@/components/ui/button";

// Inline retry, never a full-page crash (design spec §8).
export function ErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="rounded-md border border-dashed p-8 text-center">
      <p className="text-sm text-muted-foreground">{message ?? "Couldn't load this data."}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
