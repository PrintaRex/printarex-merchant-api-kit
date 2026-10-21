/**
 * Exercises `descriptionParagraphs`, `lineTotal` and the link policy on their own, with no server.
 *
 * Ways `descriptionParagraphs` could fail, each covered below:
 *  1. A script or style block keeps its content, or an unterminated one leaks everything after it.
 *  2. Tags in capitals, with attributes, or inside comments get through as tags.
 *  3. An escaped tag (`&lt;script&gt;`) is decoded and then trusted: the caller must still escape it.
 *  4. `&amp;lt;` is decoded twice and turns into `<`.
 *  5. Paragraph breaks are lost, or whitespace is not collapsed.
 *  6. Markup that never closes (`<meta http-equiv=refresh`) is left in as live-looking text.
 *
 * Ways `lineTotal` could fail, each covered below:
 *  7. Floating-point rounding gives a total that is a cent off, or loses digits on large totals.
 *  8. "5" or "5.5" are read as 5.00 cents wrong (missing zero padding).
 *  9. A malformed price is turned into a number instead of being refused.
 *
 * Ways the link policy could fail, each covered below:
 * 10. `javascript:`, `data:` or `file:` links are allowed, including with tabs or capitals hiding the scheme.
 * 11. Plain `http:` is allowed although the API is https.
 * 12. A relative or broken URL throws instead of being refused.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lineTotal } from '../src/money.ts';
import { descriptionParagraphs } from '../src/plain-text.ts';
import { allowedProtocols, safeHref } from '../src/safe-url.ts';

describe('description_html as plain text', () => {
  test('script and style blocks are removed with their content, even when never closed', () => {
    assert.deepEqual(descriptionParagraphs('<p>Hi</p><SCRIPT type="x">alert(1)</SCRIPT><style>p{display:none}</style><p>Bye</p>'), ['Hi', 'Bye']);
    assert.deepEqual(descriptionParagraphs('<p>Hi</p><script>alert(1)'), ['Hi']);
  });

  test('other tags and comments are dropped, and paragraph breaks are kept', () => {
    assert.deepEqual(descriptionParagraphs('<h1 class="x">Title</h1><p>One<br>two <b>bold</b></p><!-- <img src=x onerror=y> --><div>Three</div>'), ['Title', 'One', 'two bold', 'Three']);
  });

  test('basic entities are decoded once, and the result is still plain text for the caller to escape', () => {
    assert.deepEqual(descriptionParagraphs('<p>Tom &amp; Jerry &quot;ok&quot; &#39;x&#39;</p>'), [`Tom & Jerry "ok" 'x'`]);
    assert.deepEqual(descriptionParagraphs('&lt;script&gt;alert(1)&lt;/script&gt;'), ['<script>alert(1)</script>']);
    assert.deepEqual(descriptionParagraphs('&amp;lt;b&amp;gt;'), ['&lt;b&gt;']);
  });

  test('whitespace is collapsed and a tag that never closes stays text', () => {
    assert.deepEqual(descriptionParagraphs('  a \t  b \n\n\n c  '), ['a b', 'c']);
    assert.deepEqual(descriptionParagraphs('<p>x</p><meta http-equiv=refresh content=0'), ['x', '<meta http-equiv=refresh content=0']);
  });
});

describe('line total in whole cents', () => {
  test('exact totals, with the two-decimal format the API uses', () => {
    assert.equal(lineTotal('19.99', 3), '59.97');
    assert.equal(lineTotal('5', 2), '10.00');
    assert.equal(lineTotal('5.5', 3), '16.50');
    assert.equal(lineTotal('0.10', 3), '0.30');
    // Worked out by hand in integer cents; a floating-point product would lose the low digits.
    assert.equal(lineTotal('123456789012.99', 99_999_999), '12345678777842210987.01');
    assert.equal(lineTotal('999999999999.99', 9_007_199_254_740_991), '9007199254740900928007452590.09');
  });

  test('a price that is not a plain two-decimal amount is refused', () => {
    for (const price of ['', 'abc', '-1.00', '1.234', '1e3', '1,5', '0x10']) assert.throws(() => lineTotal(price, 1), /Unexpected price/, price);
  });
});

describe('link policy', () => {
  test('only https is allowed, and http only when the API itself is http', () => {
    const secure = allowedProtocols('https://api.printarex.example/merchant/v1');
    assert.equal(safeHref('https://track.example/a?b=1', secure), 'https://track.example/a?b=1');
    assert.equal(safeHref('http://track.example/a', secure), null);
    assert.equal(safeHref('http://track.example/a', allowedProtocols('http://localhost:8080/merchant/v1')), 'http://track.example/a');
  });

  test('dangerous, relative and broken URLs are refused', () => {
    const secure = allowedProtocols('https://api.printarex.example/merchant/v1');
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/orders/1', '//evil.example', 'not a url', '', null]) {
      assert.equal(safeHref(url, secure), null, String(url));
    }
  });
});
