import os


def launch_chromium(playwright, **options):
    channel = os.environ.get("LAB_PLAYWRIGHT_CHANNEL", "chromium")
    return playwright.chromium.launch(channel=channel, **options)
