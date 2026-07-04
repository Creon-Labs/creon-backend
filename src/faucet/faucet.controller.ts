import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { ClaimFaucetDto } from './dto/claim-faucet.dto';
import { PrepareTrustlineDto } from './dto/prepare-trustline.dto';
import { SubmitTrustlineDto } from './dto/submit-trustline.dto';
import { FaucetService } from './faucet.service';

/**
 * Public, unauthenticated test-USDC faucet (no `@UseGuards` — mirrors
 * `CampaignController`) so hackathon judges can try the platform without
 * registering first.
 */
@Controller('faucet/usdc')
export class FaucetController {
  constructor(private readonly faucet: FaucetService) {}

  /** Build an unsigned `changeTrust` tx for the wallet to sign (one-time per wallet). */
  @Post('trustline/prepare')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Trustline transaction prepared')
  prepareTrustline(@Body() dto: PrepareTrustlineDto) {
    return this.faucet.prepareTrustline(dto.walletAddress);
  }

  /** Submit the wallet-signed `changeTrust` tx; backend fee-bumps and submits it. */
  @Post('trustline/submit')
  @ResponseMessage('Trustline established')
  submitTrustline(@Body() dto: SubmitTrustlineDto) {
    return this.faucet.submitTrustline(dto.walletAddress, dto.signedXdr);
  }

  /** Send a fixed amount of test USDC to the wallet (platform-signed, cooldown-limited). */
  @Post('claim')
  @ResponseMessage('USDC claimed')
  claim(@Body() dto: ClaimFaucetDto) {
    return this.faucet.claim(dto.walletAddress);
  }
}
