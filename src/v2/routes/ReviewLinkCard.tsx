import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { createReviewLink } from '../../data/api-reviews';
import { ApiError } from '../../data/errors';
import { Card } from '../ui/Card';
import { Button } from '../ui/primitives';
import { TextField } from '../ui/Field';
import { useToast } from '../ui/Toast';

/** The order statuses a review link can be made for — the server's list. */
const LINKABLE = ['paid', 'fulfilled', 'refunded', 'partially_refunded'];

/**
 * "Ask for a review" — a link the owner copies and sends the customer
 * themselves, on WhatsApp or wherever they are talking (migration 1280).
 *
 * The customer does not need an account to use it. Each press makes a new
 * link; older ones keep working until they expire.
 */
export function ReviewLinkCard({ orderId, status }: { orderId: string; status: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  if (!LINKABLE.includes(status)) return null;

  async function make() {
    setBusy(true);
    try {
      const link = await createReviewLink(orderId);
      setUrl(link.url);
      try {
        await navigator.clipboard.writeText(link.url);
        toast.show('Review link copied — paste it into your chat');
      } catch {
        toast.show('Link ready — copy it from the box below');
      }
    } catch (cause) {
      toast.show(
        cause instanceof ApiError && cause.detail === 'no_products'
          ? 'None of the products on this order are in your shop any more.'
          : cause instanceof Error && cause.message
            ? cause.message
            : 'Something went wrong.',
        'critical',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ask for a review">
      <p className="field__hint" style={{ margin: 0 }}>
        Send this link to the customer. They can review what they bought and add photos — no
        account needed. Reviews still wait for your approval.
      </p>
      <Button busy={busy} onClick={() => void make()}>
        <Link2 aria-hidden="true" />
        {url ? 'Copy a new link' : 'Copy review link'}
      </Button>
      {url ? (
        <TextField
          label="Review link"
          hint="Works for 90 days."
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}
    </Card>
  );
}
