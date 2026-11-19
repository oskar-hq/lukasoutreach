import { MessageSquarePlus } from 'lucide-react';
import { openFeedback } from './feedbackBus';

/** Feedback-Knopf oben neben der Glocke – Desktop und Handy (auch als App vom Home-Bildschirm). */
export function FeedbackButton() {
  return (
    <button
      type="button"
      onClick={() => openFeedback()}
      aria-label="Feedback senden"
      title="Feedback senden (⌥F)"
      data-testid="nav-feedback"
      className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
    >
      <MessageSquarePlus className="h-[18px] w-[18px]" />
    </button>
  );
}
