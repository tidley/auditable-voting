import grpc
from unittest.mock import patch


class TestIssuance:
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value=None)
    def test_quote_not_found_on_mint_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory()
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_approve.assert_not_called()
        assert "a" * 64 not in issued_set

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "paid"})
    def test_quote_already_paid_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory()
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_approve.assert_not_called()
        assert "a" * 64 not in issued_set

    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_grpc_approval_success(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory()
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_approve.assert_called_once_with("localhost:9999", "3fcfc7132cdfa0dab05c4f2ac8feb65b")
        assert "a" * 64 in issued_set
        mock_publish.assert_called_once()

    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_grpc_approval_failure_not_marked_issued(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        mock_approve.side_effect = grpc.RpcError("mock error")
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory()
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_approve.assert_called_once_with("localhost:9999", "3fcfc7132cdfa0dab05c4f2ac8feb65b")
        assert "a" * 64 not in issued_set
        mock_publish.assert_not_called()


PUBLIC_MINT_URL = "http://23.182.128.64:3338"
INTERNAL_MINT_URL = "http://localhost:8787/test-mint"


class TestIssuancePublicMintUrl:
    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_accepts_public_mint_url(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint=PUBLIC_MINT_URL)
        process_issuance_request(
            event_data, eligible_set, issued_set,
            "localhost:9999", INTERNAL_MINT_URL, mock_nostr_client,
            public_mint_url=PUBLIC_MINT_URL,
        )

        mock_approve.assert_called_once()
        assert "a" * 64 in issued_set
        mock_publish.assert_called_once()
        call_args = mock_publish.call_args
        assert call_args[0][4] == PUBLIC_MINT_URL

    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_accepts_public_mint_url_with_trailing_slash(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint="http://23.182.128.64:3338/")
        process_issuance_request(
            event_data, eligible_set, issued_set,
            "localhost:9999", INTERNAL_MINT_URL, mock_nostr_client,
            public_mint_url=PUBLIC_MINT_URL,
        )

        mock_approve.assert_called_once()
        assert "a" * 64 in issued_set

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_rejects_wrong_mint_url(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint="http://192.168.1.100:9999")
        process_issuance_request(
            event_data, eligible_set, issued_set,
            "localhost:9999", INTERNAL_MINT_URL, mock_nostr_client,
            public_mint_url=PUBLIC_MINT_URL,
        )

        mock_approve.assert_not_called()
        assert "a" * 64 not in issued_set

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_rejects_internal_mint_when_public_differs(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint=INTERNAL_MINT_URL)
        process_issuance_request(
            event_data, eligible_set, issued_set,
            "localhost:9999", INTERNAL_MINT_URL, mock_nostr_client,
            public_mint_url=PUBLIC_MINT_URL,
        )

        mock_approve.assert_not_called()
        assert "a" * 64 not in issued_set

    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_no_public_mint_url_falls_back_to_mint_url(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint=INTERNAL_MINT_URL)
        process_issuance_request(
            event_data, eligible_set, issued_set,
            "localhost:9999", INTERNAL_MINT_URL, mock_nostr_client,
            public_mint_url=None,
        )

        mock_approve.assert_called_once()
        assert "a" * 64 in issued_set
        call_args = mock_publish.call_args
        assert call_args[0][4] == INTERNAL_MINT_URL

    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_38011_publishes_public_mint_url(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint=PUBLIC_MINT_URL)
        process_issuance_request(
            event_data, eligible_set, issued_set,
            "localhost:9999", INTERNAL_MINT_URL, mock_nostr_client,
            public_mint_url=PUBLIC_MINT_URL,
        )

        mock_publish.assert_called_once()
        call_args = mock_publish.call_args
        nostr_client_arg = call_args[0][0]
        election_id_arg = call_args[0][1]
        pubkey_arg = call_args[0][2]
        quote_id_arg = call_args[0][3]
        mint_url_arg = call_args[0][4]
        assert mint_url_arg == PUBLIC_MINT_URL
        assert mint_url_arg != INTERNAL_MINT_URL
