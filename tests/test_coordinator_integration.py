import requests
import responses
from unittest.mock import patch


@responses.activate
@patch("voting_coordinator_client._publish_38011")
@patch("voting_coordinator_client.approve_quote_via_grpc")
def test_full_flow_approves(mock_approve, mock_publish, eligible_set, issued_set, mock_nostr_client, event_data_factory):
    from voting_coordinator_client import process_issuance_request

    mint_url = "http://localhost:8787/test-mint"
    quote_id = "3fcfc7132cdfa0dab05c4f2ac8feb65b"
    grpc_endpoint = "localhost:9999"

    responses.get(
        f"{mint_url}/v1/mint/quote/bolt11/{quote_id}",
        json={"state": "unpaid", "amount": 1, "unit": "sat"},
        status=200,
    )

    event_data = event_data_factory()
    process_issuance_request(
        event_data, eligible_set, issued_set, grpc_endpoint, mint_url, mock_nostr_client
    )

    mock_approve.assert_called_once_with(grpc_endpoint, quote_id)
    mock_publish.assert_called_once()
    assert "a" * 64 in issued_set


@responses.activate
@patch("voting_coordinator_client.approve_quote_via_grpc")
def test_full_flow_mint_404(mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory):
    from voting_coordinator_client import process_issuance_request

    mint_url = "http://localhost:8787/test-mint"
    quote_id = "3fcfc7132cdfa0dab05c4f2ac8feb65b"
    grpc_endpoint = "localhost:9999"

    responses.get(
        f"{mint_url}/v1/mint/quote/bolt11/{quote_id}",
        status=404,
    )

    event_data = event_data_factory()
    process_issuance_request(
        event_data, eligible_set, issued_set, grpc_endpoint, mint_url, mock_nostr_client
    )

    mock_approve.assert_not_called()
    assert "a" * 64 not in issued_set


@responses.activate
@patch("voting_coordinator_client.approve_quote_via_grpc")
def test_full_flow_mint_timeout(mock_approve, eligible_set, issued_set, mock_nostr_client, event_data_factory):
    from voting_coordinator_client import process_issuance_request

    mint_url = "http://localhost:8787/test-mint"
    quote_id = "3fcfc7132cdfa0dab05c4f2ac8feb65b"
    grpc_endpoint = "localhost:9999"

    responses.get(
        f"{mint_url}/v1/mint/quote/bolt11/{quote_id}",
        body=requests.ConnectionError("timeout"),
    )

    event_data = event_data_factory()
    process_issuance_request(
        event_data, eligible_set, issued_set, grpc_endpoint, mint_url, mock_nostr_client
    )

    mock_approve.assert_not_called()
    assert "a" * 64 not in issued_set
