import { brand } from '../brand';
import './brand.css';

/**
 * The publication's logo, in the variant that suits the current surface.
 *
 * Both variants are rendered and CSS picks one, rather than React choosing from
 * a theme value. That is deliberate: the theme resolves from three sources
 * (`data-theme="dark"`, `data-theme="light"`, and the OS preference when
 * neither is set), and reading it in JS means the first paint can show the
 * wrong logo for a frame before an effect corrects it. CSS has the answer
 * before React runs at all, and `brand.css` mirrors the same three selectors
 * `tokens.css` uses, so the logo can never disagree with the palette around it.
 *
 * Falls back to the name as text when a tenant has no artwork — a fresh
 * install with an empty `public/brand/` still renders something sensible.
 */
export function BrandLogo({
  variant = 'lockup',
  className = '',
}: {
  /** `lockup` is mark + wordmark; `mark` is the square symbol alone. */
  variant?: 'lockup' | 'mark';
  className?: string;
}) {
  const { assets, name } = brand;
  const light = variant === 'lockup' ? assets.logoLight : assets.logomarkLight;
  const dark = variant === 'lockup' ? assets.logoDark : assets.logomarkDark;

  if (!light || !dark) {
    return <span className={`brandlogo brandlogo--text ${className}`}>{name}</span>;
  }

  return (
    <span className={`brandlogo brandlogo--${variant} ${className}`}>
      {/* BOTH carry the name. `display: none` removes an element from the
          accessibility tree, so exactly one is ever exposed — whereas naming
          only the light one left the logo nameless in dark mode, which is where
          it was actually caught. */}
      <img className="brandlogo__light" src={light} alt={name} />
      <img className="brandlogo__dark" src={dark} alt={name} />
    </span>
  );
}
