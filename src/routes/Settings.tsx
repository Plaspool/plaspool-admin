import { Link } from 'react-router-dom';
import { ChevronLeft, Check } from 'lucide-react';
import { Select } from '../components/ui/Select';
import { Switch } from '../components/ui/Switch';
import { TEMPLATES, useSettings, type ReadingTemplate, type ThemeSetting } from '../data/settings';
import './settings.css';

/** A tiny wireframe of each layout, drawn in CSS — no screenshots to go stale. */
function TemplatePreview({ id }: { id: ReadingTemplate }) {
  return (
    <div className={`tpv tpv--${id}`} aria-hidden="true">
      {id === 'editorial' && <span className="tpv__cover" />}
      {id === 'technical' ? (
        <span className="tpv__split">
          <span className="tpv__rail">
            <span className="tpv__line tpv__line--xs" />
            <span className="tpv__line tpv__line--xs" />
            <span className="tpv__line tpv__line--xs" />
          </span>
          <span className="tpv__col">
            <span className="tpv__title" />
            <span className="tpv__line" />
            <span className="tpv__line" />
            <span className="tpv__line tpv__line--short" />
          </span>
        </span>
      ) : (
        <>
          <span className="tpv__title" />
          {id !== 'minimal' && <span className="tpv__sub" />}
          {id === 'magazine' && <span className="tpv__cover tpv__cover--wide" />}
          <span className="tpv__line" />
          <span className="tpv__line" />
          <span className="tpv__line tpv__line--short" />
        </>
      )}
    </div>
  );
}

export default function SettingsRoute() {
  const [settings, update] = useSettings();

  return (
    <div className="settings">
      <header className="settings__bar">
        <Link className="btn btn--ghost btn--sm" to="/">
          <ChevronLeft className="ui-ic" aria-hidden="true" />
          Posts
        </Link>
        <span className="settings__title">Settings</span>
        <span aria-hidden="true" />
      </header>

      <main className="settings__page">
        <section className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__h">Reading layout</h2>
            <p className="settings__desc">
              How an article is presented in the reader and in preview. Changing
              this never touches what you wrote — only how it's laid out.
            </p>
          </div>

          <div
            className="tplgrid"
            role="radiogroup"
            aria-label="Reading layout"
          >
            {TEMPLATES.map((t) => {
              const active = settings.template === t.id;
              return (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={active}
                  className={`tplcard${active ? ' is-active' : ''}`}
                  onClick={() => update({ template: t.id })}
                >
                  <TemplatePreview id={t.id} />
                  <span className="tplcard__body">
                    <span className="tplcard__name">
                      {t.name}
                      {active && <Check className="ui-ic tplcard__check" aria-hidden="true" />}
                    </span>
                    <span className="tplcard__desc">{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__h">Appearance</h2>
          </div>
          <div className="settings__rows">
            <div className="settings__row">
              <div>
                <p className="settings__label">Theme</p>
                <p className="settings__hint">
                  Match your system, or pin one.
                </p>
              </div>
              <Select<ThemeSetting>
                label="Theme"
                value={settings.theme}
                onChange={(v) => update({ theme: v })}
                options={[
                  { value: 'system', label: 'Match system' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>

            <div className="settings__row">
              <div>
                <p className="settings__label">Reading progress bar</p>
                <p className="settings__hint">
                  A thin indicator across the top of an article.
                </p>
              </div>
              <Switch
                label="Reading progress bar"
                checked={settings.readingProgress}
                onChange={(v) => update({ readingProgress: v })}
              />
            </div>

            <div className="settings__row">
              <div>
                <p className="settings__label">Show reading time</p>
                <p className="settings__hint">
                  Estimated minutes, on cards and bylines.
                </p>
              </div>
              <Switch
                label="Show reading time"
                checked={settings.showReadingTime}
                onChange={(v) => update({ showReadingTime: v })}
              />
            </div>
          </div>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__h">Author</h2>
          </div>
          <div className="settings__rows">
            <div className="settings__row">
              <div>
                <p className="settings__label">Byline name</p>
                <p className="settings__hint">Printed on every article.</p>
              </div>
              <input
                className="input settings__input"
                value={settings.authorName}
                maxLength={60}
                aria-label="Byline name"
                onChange={(e) => update({ authorName: e.target.value })}
              />
            </div>
          </div>
        </section>

        <p className="settings__footnote">
          Settings live in this browser only.{' '}
          {/* TODO(backend): sync to the user document; see ARCHITECTURE.md. */}
          They are not part of an export, because they describe this device
          rather than your writing.
        </p>
      </main>
    </div>
  );
}
