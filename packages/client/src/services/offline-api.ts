import {
    MarketStats,
    UniswapPair,
    UniswapSwap,
    UniswapMintOrBurn,
    UniswapDailyData,
    UniswapHourlyData,
    LPPositionData,
} from '@sommelier/shared-types';

import { IError } from 'types/states';

import initalData from 'constants/initialData.json';

type ApiResponse<T> = { data?: T; error?: IError };

export class UniswapApiFetcher {
    static async getPairOverview(
        pairId: string
    ): Promise<ApiResponse<UniswapPair>> {
        return Promise.resolve({ data: initalData.pairData as UniswapPair });
    }

    static async getLatestSwaps(
        pairId: string
    ): Promise<ApiResponse<UniswapSwap[]>> {
        return Promise.resolve({ data: initalData.swaps as UniswapSwap[] });
    }

    static async getMintsAndBurns(
        pairId: string
    ): Promise<
        ApiResponse<{
            mints: UniswapMintOrBurn[];
            burns: UniswapMintOrBurn[];
            combined: UniswapMintOrBurn[];
        }>
    > {
        return Promise.resolve({
            data: {
                mints: initalData.mints as UniswapMintOrBurn[],
                burns: initalData.burns as UniswapMintOrBurn[],
                combined: initalData.combined as UniswapMintOrBurn[],
            },
        });
    }

    static async getTopPairs(
        count = 1000
    ): Promise<ApiResponse<UniswapPair[]>> {
        return Promise.resolve({ data: initalData.allPairs as UniswapPair[] });
    }

    static async getMarketData(
        startDate = '2020-12-01'
    ): Promise<ApiResponse<MarketStats[]>> {
        return Promise.resolve({
            data: initalData.marketData as MarketStats[],
        });
    }

    static async getDailyTopPerformingPairs(): Promise<
        ApiResponse<MarketStats[]>
    > {
        return Promise.resolve({
            data: initalData.dailyTopPairs as MarketStats[],
        });
    }

    static async getWeeklyTopPerformingPairs(): Promise<
        ApiResponse<MarketStats[]>
    > {
        return Promise.resolve({
            data: initalData.weeklyTopPairs as MarketStats[],
        });
    }

    static async getHistoricalDailyData(
        pairId: string,
        startDate: Date,
        endDate = new Date()
    ): Promise<ApiResponse<UniswapDailyData[]>> {
        return Promise.resolve({
            data: initalData.historicalDailyData as UniswapDailyData[],
        });
    }

    static async getHistoricalHourlyData(
        pairId: string,
        startDate: Date,
        endDate = new Date()
    ): Promise<ApiResponse<UniswapHourlyData[]>> {
        return Promise.resolve({
            data: initalData.historicalHourlyData as UniswapHourlyData[],
        });
    }

    static async getPositionStats(
        address: string
    ): Promise<ApiResponse<LPPositionData<string>>> {
        const response = await fetch(
            `/api/v1/uniswap/positions/${address}/stats`
        );
        const { data, error } = await (response.json() as Promise<
            ApiResponse<LPPositionData<string>>
        >);
        return { data, error };
    }
}