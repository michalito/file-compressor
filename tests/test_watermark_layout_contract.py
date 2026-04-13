import json
from pathlib import Path

from app.compression.image_processor import ImageCompressor


CONTRACT_PATH = Path(__file__).parent / 'fixtures' / 'watermark-layout-contract.json'


def load_contract():
    with CONTRACT_PATH.open('r', encoding='utf-8') as contract_file:
        return json.load(contract_file)


def test_backend_watermark_layout_matches_contract():
    contract = load_contract()

    for case in contract['textFontCases']:
        font_px = ImageCompressor._get_text_watermark_font_px(
            case['width'],
            case['height'],
            case['size'],
        )
        assert font_px == case['fontPx'], case['name']
        assert ImageCompressor._get_text_watermark_margin(font_px) == case['margin'], case['name']

    for case in contract['imageCases']:
        assert ImageCompressor._get_image_watermark_max_side(
            case['width'],
            case['height'],
            case['size'],
        ) == case['maxSide'], case['name']
        assert ImageCompressor._get_image_watermark_margin(
            case['width'],
            case['height'],
        ) == case['margin'], case['name']

    for case in contract['tileCases']:
        spacing_x, spacing_y = ImageCompressor._get_tile_spacing(
            case['stampWidth'],
            case['stampHeight'],
            case['tileDensity'],
        )
        assert spacing_x == case['spacingX'], case['name']
        assert spacing_y == case['spacingY'], case['name']

    for case in contract['positionCases']:
        x, y = ImageCompressor._calc_watermark_position(
            case['position'],
            case['imgW'],
            case['imgH'],
            case['stampW'],
            case['stampH'],
            case['margin'],
        )
        assert x == case['x'], case['name']
        assert y == case['y'], case['name']
