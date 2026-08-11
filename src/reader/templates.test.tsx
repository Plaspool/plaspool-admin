// @vitest-environment jsdom
/**
 * Which layout wins.
 *
 * One function decides, and it is the seam between a device preference and a
 * property of the post — the kind of place this codebase has repeatedly found
 * its bugs. `null` and a pinned value must behave differently when the blog
 * default changes underneath them, which is the whole reason the field is
 * nullable rather than defaulted.
 */
import { describe, expect, it } from 'vitest';
import { resolveTemplate } from './templates';
import { DEFAULT_SETTINGS, type Settings } from '../data/settings';
import type { Post } from '../data/types';

const settings = (template: Settings['template']): Settings => ({
  ...DEFAULT_SETTINGS,
  template,
});

const post = (template: Post['template']) => ({ template });

describe('resolveTemplate', () => {
  it('follows the blog default when the post has no opinion', () => {
    expect(resolveTemplate(post(null), settings('minimal'))).toBe('minimal');
    expect(resolveTemplate(post(null), settings('technical'))).toBe('technical');
  });

  it('lets a pinned post win over the blog default', () => {
    expect(resolveTemplate(post('editorial'), settings('minimal'))).toBe('editorial');
  });

  it('keeps a pinned post fixed when the blog default changes', () => {
    const pinned = post('editorial');
    expect(resolveTemplate(pinned, settings('magazine'))).toBe('editorial');
    expect(resolveTemplate(pinned, settings('technical'))).toBe('editorial');
  });

  it('moves an un-pinned post when the blog default changes', () => {
    const free = post(null);
    expect(resolveTemplate(free, settings('magazine'))).toBe('magazine');
    expect(resolveTemplate(free, settings('editorial'))).toBe('editorial');
  });

  it('treats a pin that matches the default as still pinned', () => {
    // Not the same state as `null`: this one must NOT move when the default does.
    const pinnedToDefault = post('magazine');
    expect(resolveTemplate(pinnedToDefault, settings('magazine'))).toBe('magazine');
    expect(resolveTemplate(pinnedToDefault, settings('minimal'))).toBe('magazine');
  });
});
