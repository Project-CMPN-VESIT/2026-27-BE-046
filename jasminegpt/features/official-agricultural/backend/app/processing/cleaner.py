import re
from bs4 import BeautifulSoup


def clean_html(html):
    """
    Extract useful readable content from HTML.
    Removes scripts, styles, navigation and UI elements.
    """

    soup = BeautifulSoup(html, "html.parser")

    # Remove elements that generally do not contain useful knowledge
    unwanted_tags = [
        "script",
        "style",
        "nav",
        "footer",
        "header",
        "form",
        "button",
        "input",
        "iframe",
        "noscript",
        "svg"
    ]

    for tag in soup.find_all(unwanted_tags):
        tag.decompose()

    # Extract title
    title = ""

    if soup.title:
        title = soup.title.get_text(
            " ",
            strip=True
        )

    content_parts = []

    # Preserve headings
    for element in soup.find_all(
        ["h1", "h2", "h3", "h4", "h5", "h6",
         "p", "li", "td", "th"]
    ):

        text = element.get_text(
            " ",
            strip=True
        )

        if text:
            content_parts.append(text)

    text = "\n".join(content_parts)

    # Remove excessive whitespace
    text = re.sub(
        r"[ \t]+",
        " ",
        text
    )

    # Remove excessive blank lines
    text = re.sub(
        r"\n+",
        "\n",
        text
    )

    # Remove obvious code fragments
    lines = []

    for line in text.splitlines():

        line = line.strip()

        if not line:
            continue

        if line.startswith("//"):
            continue

        if line.startswith("/*"):
            continue

        if "<script" in line.lower():
            continue

        if "javascript:" in line.lower():
            continue

        lines.append(line)

    text = "\n".join(lines)

    return {
        "title": title,
        "text": text.strip()
    }


def clean_text(text):
    """
    Clean already extracted plain text.
    """

    text = re.sub(r"\s+", " ", text)

    return text.strip()