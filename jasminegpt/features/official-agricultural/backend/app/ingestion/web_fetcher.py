import requests
from bs4 import BeautifulSoup


def fetch_webpage(url):
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) "
            "Chrome/140.0 Safari/537.36"
        )
    }

    response = requests.get(
        url,
        headers=headers,
        timeout=20
    )

    response.raise_for_status()

    return response.text


def extract_text(html):
    soup = BeautifulSoup(html, "html.parser")

    for element in soup(
        ["script", "style", "nav", "footer", "header"]
    ):
        element.decompose()

    text = soup.get_text(
        separator=" ",
        strip=True
    )

    return text


def fetch_and_extract(url):
    html = fetch_webpage(url)
    text = extract_text(html)

    return text