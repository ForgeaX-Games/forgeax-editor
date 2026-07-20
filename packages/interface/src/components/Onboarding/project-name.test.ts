import { describe, expect, test } from 'bun:test';
import { isUserExistingGame, resolveProjectName, toGameSlug } from './project-name';

describe('toGameSlug', () => {
  test('normalizes to lowercase slug', () => {
    expect(toGameSlug(' My Game ')).toBe('my-game');
  });
});

describe('isUserExistingGame', () => {
  test('hides the default session stub', () => {
    expect(isUserExistingGame('default')).toBe(false);
  });

  test('keeps real project slugs', () => {
    expect(isUserExistingGame('untitled-1')).toBe(true);
    expect(isUserExistingGame('my-game')).toBe(true);
  });
});

describe('resolveProjectName', () => {
  test('keeps a typed usable name', () => {
    expect(resolveProjectName('hello-world', [])).toEqual({
      name: 'hello-world',
      slug: 'hello-world',
    });
  });

  test('empty / whitespace → untitled-1', () => {
    expect(resolveProjectName('', [])).toEqual({
      name: 'untitled-1',
      slug: 'untitled-1',
    });
    expect(resolveProjectName('  ', [])).toEqual({
      name: 'untitled-1',
      slug: 'untitled-1',
    });
  });

  test('single-char name is kept', () => {
    expect(resolveProjectName('a', [])).toEqual({
      name: 'a',
      slug: 'a',
    });
  });

  test('skips existing untitled-N slugs', () => {
    expect(resolveProjectName('', ['untitled-1', 'untitled-2', 'other'])).toEqual({
      name: 'untitled-3',
      slug: 'untitled-3',
    });
  });
});
