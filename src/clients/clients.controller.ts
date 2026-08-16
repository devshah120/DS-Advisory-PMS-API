import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

/**
 * The authenticated caller, as JwtAuthGuard/JwtStrategy leaves it on the
 * request. Typed locally so every handler reads `req.user` as an Actor rather
 * than `any` — the ownership filter is only as good as the identity it is
 * handed, and `any` here would let a typo silently scope nothing.
 */
type AuthedRequest = { user: Actor };

const MAX_LIMIT = 100;

@Controller('clients')
@UseGuards(JwtAuthGuard)
export class ClientsController {
  constructor(private clientsService: ClientsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() createClientDto: CreateClientDto, @Req() req: AuthedRequest) {
    return this.clientsService.create(createClientDto, req.user);
  }

  @Get()
  findAll(
    @Req() req: AuthedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('market') market?: string
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
    // Absent `market` deliberately stays undefined rather than defaulting to the
    // US book — an unscoped list must keep returning every book, since the
    // client management screens page across both. Ownership is NOT optional in
    // the same way: it is always applied, from req.user.
    return this.clientsService.findAll(
      req.user,
      (safePage - 1) * safeLimit,
      safeLimit,
      market ? parseMarket(market) : undefined
    );
  }

  @Get('count')
  count(@Req() req: AuthedRequest) {
    return this.clientsService.count(req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.clientsService.findOne(id, req.user);
  }

  @Get(':id/metrics')
  getMetrics(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.clientsService.getClientMetrics(id, req.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateClientDto: UpdateClientDto,
    @Req() req: AuthedRequest
  ) {
    return this.clientsService.update(id, updateClientDto, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.clientsService.remove(id, req.user);
  }
}
