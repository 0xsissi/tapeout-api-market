from .client import ClawMarket
from .agent import TAMAgentClient

TAM = ClawMarket
TapeoutAPIMarket = ClawMarket

__all__ = ["TAM", "TapeoutAPIMarket", "ClawMarket", "TAMAgentClient"]
