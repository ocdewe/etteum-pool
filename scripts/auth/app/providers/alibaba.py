"""Alibaba (DashScope) provider adapter for warmup/login."""

from __future__ import annotations

import json
from typing import Any

from .base import NormalizedAccount, ProviderAdapter, ProviderResult


class AlibabaProviderAdapter(ProviderAdapter):
    """Alibaba DashScope — API key based, no login/session needed."""

    name = "alibaba"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        """Parse 'email|api_key' format."""
        parts = raw_line.strip().split("|", 1)
        if len(parts) != 2:
            raise ValueError(f"Invalid format, expected 'email|api_key', got: {raw_line[:80]}")
        return NormalizedAccount(
            provider=self.name,
            identifier=parts[0].strip(),
            secret=parts[1].strip(),
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> None:
        """No session needed for API key auth."""
        return None

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        """No auth step needed — API key is used directly."""
        return {"api_key": account.secret}

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        """Return the API key as the token."""
        return {"api_key": account.secret}

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        """DashScope doesn't expose a quota API. Return unlimited."""
        return {
            "limit": 1000000,
            "remaining": 1000000,
            "used": 0,
            "reset_at": None,
            "source": "alibaba.no_api",
        }

    async def cleanup_session(self, session: Any) -> None:
        """Nothing to clean up."""
        pass
