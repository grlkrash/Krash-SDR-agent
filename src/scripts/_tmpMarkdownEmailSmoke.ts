// npx tsx src/scripts/_tmpMarkdownEmailSmoke.ts
import { markdownToEmailHtmlFragment, markdownToPlainText } from '../shared/markdownHtml.js';

const sample = `# 📊 Pipeline brief — 2026-05-29

## 📬 New replies (24h) — 1
- **Smoke Test Recovery Center LLC** (Cincinnati, OH) · Mark · 5h ago
  > _(snippet unavailable — open queue to view)_
  [→ Review in queue](https://example.com/queue#draft-1)

## 📞 Renewals to call (7-day touch window)
_[Open renewals call queue](https://example.com/renewals-call) (2 pending)_
1. **Smoke Test Recovery Center LLC** (Cincinnati, OH) — (513) 299-8805
`;

const html = markdownToEmailHtmlFragment(sample);
const plain = markdownToPlainText(sample);

console.log(JSON.stringify({
  plainHasHash: plain.includes('##'),
  plainHasBold: plain.includes('**'),
  htmlHasHash: html.includes('##'),
  htmlHasH2: html.includes('<h2'),
  htmlHasAnchor: html.includes('<a href'),
}));
