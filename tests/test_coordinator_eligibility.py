from unittest.mock import patch


class TestEligibility:
    @patch("voting_coordinator_client._publish_38011")
    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint", return_value={"state": "unpaid"})
    def test_eligible_voter_approved(
        self, mock_verify, mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory()
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_called_once_with("http://localhost:8787/test-mint", "3fcfc7132cdfa0dab05c4f2ac8feb65b")
        mock_approve.assert_called_once_with("localhost:9999", "3fcfc7132cdfa0dab05c4f2ac8feb65b")
        mock_publish.assert_called_once()
        assert "a" * 64 in issued_set

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint")
    def test_non_eligible_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(pubkey="z" * 64)
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_not_called()
        mock_approve.assert_not_called()

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint")
    def test_already_issued_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        issued_set.add("a" * 64)
        event_data = event_data_factory()
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_not_called()
        mock_approve.assert_not_called()

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint")
    def test_missing_quote_tag_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(quote=None)
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_not_called()
        mock_approve.assert_not_called()

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint")
    def test_wrong_amount_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(amount="2")
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_not_called()
        mock_approve.assert_not_called()

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint")
    def test_wrong_mint_url_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(mint="http://other-mint.example.com")
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_not_called()
        mock_approve.assert_not_called()

    @patch("voting_coordinator_client.approve_quote_via_grpc")
    @patch("voting_coordinator_client.verify_quote_on_mint")
    def test_amount_missing_skipped(
        self, mock_verify, mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory
    ):
        from voting_coordinator_client import process_issuance_request

        event_data = event_data_factory(amount=None)
        process_issuance_request(
            event_data, eligible_set, issued_set, "localhost:9999", "http://localhost:8787/test-mint", mock_nostr_client
        )

        mock_verify.assert_not_called()
        mock_approve.assert_not_called()
