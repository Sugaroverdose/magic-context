import { registerIssue424Tests } from "@magic-context/core/hooks/magic-context/issue-424-test-support.test";
import { convertEntriesToRawMessages } from "./read-session-pi";

registerIssue424Tests("pi", (fixture) =>
	convertEntriesToRawMessages(fixture.entries),
);
