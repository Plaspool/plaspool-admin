import { useSearchParams } from 'react-router-dom';
import { ReturnDetail } from './marketing/ReturnDetail';
import { ReturnsScreen } from './marketing/ReturnsScreen';
import './marketing.css';

/**
 * Returns — a desk, a board per served district, and one return at a time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE SURFACES BEHIND ONE ROUTE, AND THE URL SAYS WHICH.
 *
 *   - nothing            → the DESK above one district's BOARD (`?district=`)
 *   - `?id=`             → the same board with that card open as a modal over it
 *   - `?id=…&act=inspect`→ the full INSPECTION screen
 *
 * THE INSPECTION IS A WHOLE SCREEN AND NOT A MODAL, deliberately. It has derived
 * quantities, a live award sentence and a confirmation that restates it — the
 * one write in this subsystem that creates value and cannot be taken back.
 * Squeezing it into a panel over a board would be a second, smaller version of
 * the screen that exists for it, and it is the version somebody would use in a
 * hurry.
 *
 * Everything else opens as a modal over the blurred board, because the next
 * thing an operator does is close it and move a different card — and a page
 * navigation makes that a back-button round trip that loses the board's scroll.
 *
 * `key` REMOUNTS THE DETAIL on a change of return: it holds a half-typed
 * inspection, and carrying one return's counts into the next one is the worst
 * thing this screen could do.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function MarketingReturns() {
  const [params] = useSearchParams();
  const openId = params.get('id');
  const inspecting = params.get('act') === 'inspect';

  if (openId !== null && inspecting) return <ReturnDetail key={openId} id={openId} />;

  /*
   * The page frame belongs here rather than to each half, because the board and
   * the modal share it — the modal is drawn OVER the board, not instead of it,
   * which is the whole reason it reads as a card lifted off the surface.
   */
  return (
    <div className={`mktscr${openId === null ? '' : ' mktscr--modal'}`}>
      <ReturnsScreen />
    </div>
  );
}
