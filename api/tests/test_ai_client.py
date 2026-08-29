"""The provider client's parsing, without the provider.

`generate_json` asks for JSON by mime type and schema, and almost always gets
exactly that. The cases here are the rare shapes seen on vision requests: a
fenced block, and a reply split into "thought" and answer parts.
"""

from __future__ import annotations

import json

from app.services.ai import _unfenced


class TestUnfencing:
    def test_plain_json_is_untouched(self) -> None:
        text = '{"answer": "Rest today.", "urgency": "ROUTINE"}'
        assert _unfenced(text) == text

    def test_a_json_fence_is_removed(self) -> None:
        text = '```json\n{"answer": "Rest today."}\n```'
        assert json.loads(_unfenced(text)) == {"answer": "Rest today."}

    def test_a_bare_fence_is_removed(self) -> None:
        text = '```\n{"answer": "Rest today."}\n```'
        assert json.loads(_unfenced(text)) == {"answer": "Rest today."}

    def test_surrounding_whitespace_does_not_matter(self) -> None:
        text = '\n\n  ```json\n{"a": 1}\n```  \n'
        assert json.loads(_unfenced(text)) == {"a": 1}

    def test_the_content_inside_is_not_altered(self) -> None:
        # A value that itself contains backticks must survive: only the outer
        # fence is the model's decoration, everything else is its answer.
        inner = '{"answer": "Use the `inhaler` as prescribed."}'
        assert _unfenced(f"```json\n{inner}\n```") == inner
