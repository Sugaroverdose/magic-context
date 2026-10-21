export const CTX_REDUCE_DESCRIPTION = `Stamp items you've consumed to free your context window. Not a delete: stamping QUEUES it, the item stays fully readable until Magic Context clears stamped items in one sweep, and the newest items are protected, so a stamp on recent output applies only once newer work displaces it. A cleared item goes to the archive — a recent one leaves a placeholder, an older one leaves nothing — and \`ctx_expand(message=N)\` is the way back. So the question before stamping is not "have I finished reading this?" but "does this need to stay in your context for the work ahead?" — a file you read and will keep editing stays; the grep that found it goes. A reply you are writing has not served its purpose until the user responds to it.

Point at items with \`ctx_handles\`: a tool call id copied exactly from the call, the shortest phrase copied word-for-word from a message's text (your prose, and what you were given as prose) that only that one item on the desk matches — a tool call is released ONLY by its call id — its arguments and its output are never stamp identifiers, copy the id from the call, a span of two such pointers joined by \`..\`, stamping them and everything in between, and any mix of these in one list.
Examples —
single id: \`["call_81cf34"]\`
single phrase: \`["Connection refused at 127.0.0.1:5432"]\`
id span: \`["call_81cf34..call_b3fa07"]\`
phrase span: \`["npm run build failed with 3 errors..migrations applied cleanly on 41b2c9"]\`
mixed span: \`["call_81cf34..migrations applied cleanly on 41b2c9"]\`
mixed list: \`["call_81cf34", "npm run build failed with 3 errors..migrations applied cleanly on 41b2c9", "Connection refused at 127.0.0.1:5432"]\`
(leave the list empty — or omit it — to stamp everything you have already replied to)

Matching looks only at items still in your context: unique there is unique, and what you cannot see is not a candidate. One call is one action: an entry that matches nothing, with resolvable siblings, reports only its slot and the rest stamps — re-issue that entry alone; a quote that matches more than one visible item, a range with a dead endpoint, or a call where every entry failed stamps nothing and names the input that failed — correct it and send the same batch again; entries whose items are already gone, are queued, or are protected are reported, not retried. The response answers the list slot for slot, in the order you sent it, with each item's position in your context — re-read any with \`ctx_expand(message=N)\`; a span slot reports its ordinal range (\`"10-12"\`) and feeds \`ctx_expand(start=10, end=12)\`.

Stamp: file reads, search results and tool outputs the work ahead no longer needs; build/test output after you acted on it; repeated or redundant dumps; data written to disk; status/log output that only confirmed what you expected; a large block pasted inside a user message once you have used it.
Keep: user messages (never stamp one for its directive), the message you are writing, your own conversation text, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may still matter.

Do not stamp your own current reasoning or anything you have not yet acted on.`;
