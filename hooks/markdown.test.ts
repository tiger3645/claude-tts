import { expect, test } from 'claude-code/testing'

import { stripMarkdown } from './markdown'

test('drops fenced code blocks silently', () => {
  const text = 'Run this:\n\n```ts\nconst x = 1\n```\n\nDone.'
  expect(stripMarkdown(text)).toBe('Run this:\n\nDone.')
})

test('drops tilde fences too', () => {
  expect(stripMarkdown('~~~\nls\n~~~')).toBe('')
  expect(stripMarkdown('Before\n```\nx\n```\nAfter')).toBe('Before\n\nAfter')
})

test('keeps inline code text but drops the backticks', () => {
  expect(stripMarkdown('Call `foo()` now.')).toBe('Call foo() now.')
})

test('keeps link text, says "link" for bare URLs', () => {
  expect(
    stripMarkdown('See [the docs](https://example.com/x), <https://a.b> and https://c.d/e.'),
  ).toBe('See the docs, link and link.')
})

test('drops images to their alt text', () => {
  expect(stripMarkdown('![a cat](cat.png)')).toBe('a cat')
})

test('drops heading, list, quote and emphasis markers', () => {
  const text = '# Title\n\n- **bold** item\n* _it_ item\n1. ~~gone~~ step\n> quoted'
  expect(stripMarkdown(text)).toBe('Title\n\nbold item\nit item\ngone step\nquoted')
})

test('turns table rows into plain text and drops separator rows', () => {
  const text = '| Name | Age |\n|------|----:|\n| Ann | 3 |'
  expect(stripMarkdown(text)).toBe('Name, Age\nAnn, 3')
})

test('drops horizontal rules and html tags, collapses blank runs', () => {
  expect(stripMarkdown('a\n\n---\n\n\n<br/>b')).toBe('a\n\nb')
})

test('keeps underscores inside words', () => {
  expect(stripMarkdown('snake_case_name')).toBe('snake_case_name')
})
