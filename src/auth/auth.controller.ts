import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ChallengeDto } from './dto/challenge.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Request a challenge message to sign with the wallet. */
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  challenge(@Body() dto: ChallengeDto): Promise<{ message: string }> {
    return this.auth.createChallenge(dto.walletAddress);
  }

  /** Register a new user (proves wallet ownership via signature). */
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<{ accessToken: string }> {
    return this.auth.register(dto);
  }

  /** Log in an existing user (proves wallet ownership via signature). */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<{ accessToken: string }> {
    return this.auth.login(dto);
  }
}
